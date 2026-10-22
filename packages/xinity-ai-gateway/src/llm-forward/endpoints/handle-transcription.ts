import { resolveAuth } from "../ai-sdk";
import { getModelInfo } from "../model-data";
import { releaseCallbacks } from "../release-registry";
import {
  enqueueStreamErrorEvent,
  errorResponse,
  forwardBackendError,
  handleEndpointError,
  handleStreamError,
  isAbortError,
  modelLookupFailureResponse,
  readSSEStream,
  recordFailedRequest,
  recordUsage,
  TRUNCATED_STREAM_MESSAGE,
  sseEncoder,
  sseResponse,
  validateModelType,
  type BackendRoute,
  type FailedRequestContext,
  type UsageData,
} from "../util";
import { backendPostForm, createIdleTimeout, type IdleTimeout } from "../backend-fetch";
import { config } from "../../config";
import { BackendTranscriptionChunkSchema, BackendUsageSchema } from "../backend-schemas";
import { recordTimeToFirstToken } from "../../metrics";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "handle-transcription" });

const DIARIZATION_TAG = "diarization";
const DIARIZED_FORMAT = "diarized_json";
const KNOWN_SPEAKER_FIELDS = ["known_speaker_names", "known_speaker_references"];

type StreamEvent = Record<string, unknown>;
type Transcript = { add: (delta: string) => StreamEvent[]; text: () => string };

function plainTranscript(): Transcript {
  let text = "";
  return {
    add: (delta) => {
      text += delta;
      return [{ type: "transcript.text.delta", delta }];
    },
    text: () => text,
  };
}

// OpenAI labels anonymous speakers A, B, ..., Z, AA, ... in the order they first speak.
function speakerLabels(): (speaker: string) => string {
  const labels = new Map<string, string>();
  return (speaker) => {
    let label = labels.get(speaker);
    if (!label) {
      label = "";
      for (let n = labels.size + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
      }
      labels.set(speaker, label);
    }
    return label;
  };
}

// A diarizing model writes each segment as `[start][S01]text[end]`.
const SEGMENT = /\[(\d+(?:\.\d+)?)\]\s*\[(S\d+)\](.*?)\[(\d+(?:\.\d+)?)\]/gs;
const SPEAKER_MARKUP = /\[\d+(?:\.\d+)?\]|\[S\d+\]/g;

// Text, speaker and times are only all known once a segment has ended, so the stream sends whole segments.
function segmentedTranscript(withSegments: boolean): Transcript {
  const speakerOf = speakerLabels();
  const texts: string[] = [];
  let buffer = "";
  return {
    add: (delta) => {
      buffer += delta;
      const events: StreamEvent[] = [];
      let consumed = 0;
      for (const match of buffer.matchAll(SEGMENT)) {
        const [whole, start, speaker, body, end] = match;
        const id = `seg_${texts.length}`;
        const text = body!.trim();
        const separated = texts.length > 0 ? ` ${text}` : text;
        texts.push(text);
        if (withSegments) {
          events.push({ type: "transcript.text.delta", delta: separated, segment_id: id });
          events.push({ type: "transcript.text.segment", id, start: Number(start), end: Number(end), text, speaker: speakerOf(speaker!) });
        } else {
          events.push({ type: "transcript.text.delta", delta: separated });
        }
        consumed = match.index + whole.length;
      }
      buffer = buffer.slice(consumed);
      return events;
    },
    text: () => texts.join(" "),
  };
}

function withoutSpeakerMarkup(text: string): string {
  return text.replace(SPEAKER_MARKUP, " ").replace(/\s+/g, " ").trim();
}

function plainBody(body: string, json: boolean): string {
  if (!json) {
    return withoutSpeakerMarkup(body);
  }
  try {
    const parsed = JSON.parse(body) as { text?: unknown };
    return typeof parsed.text === "string" ? JSON.stringify({ ...parsed, text: withoutSpeakerMarkup(parsed.text) }) : body;
  } catch {
    return body;
  }
}

function withOpenAISpeakers(body: string): string {
  let parsed: { segments?: { speaker?: unknown }[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!Array.isArray(parsed.segments)) {
    return body;
  }
  const speakerOf = speakerLabels();
  for (const segment of parsed.segments) {
    if (typeof segment.speaker === "string") {
      segment.speaker = speakerOf(segment.speaker);
    }
  }
  return JSON.stringify(parsed);
}

// vLLM reports a non-streamed transcription's usage as audio seconds, which has no token count to record.
function tokenUsageOf(body: string): UsageData | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const usage = BackendUsageSchema.safeParse((parsed as { usage?: unknown }).usage);
  return usage.success && usage.data
    ? { prompt_tokens: usage.data.prompt_tokens, completion_tokens: usage.data.completion_tokens }
    : undefined;
}

/** Translate vLLM's chat-completion-style transcription stream into OpenAI's `transcript.text.delta`/`transcript.text.done` events (no `[DONE]` sentinel). */
function streamTranscriptionAsOpenAI(
  backendResponse: Response,
  logFields: FailedRequestContext,
  deployment: string,
  transcript: Transcript,
  idle?: IdleTimeout,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const send = (events: StreamEvent[]) => {
        for (const event of events) {
          controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      };
      let completed = false;
      let ttftRecorded = false;
      let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
      try {
        for await (const event of readSSEStream(backendResponse)) {
          idle?.reset();
          if (event.data === "[DONE]") { completed = true; break; }
          let json: unknown;
          try {
            json = JSON.parse(event.data);
          } catch {
            continue;
          }
          const parsed = BackendTranscriptionChunkSchema.safeParse(json);
          if (!parsed.success) {
            log.warn({ issues: parsed.error.issues }, "Malformed backend transcription chunk, skipping");
            continue;
          }
          if (parsed.data.usage) {
            usage = parsed.data.usage;
          }
          const choice = parsed.data.choices[0];
          if (choice?.finish_reason) {
            completed = true;
          }
          const content = choice?.delta.content;
          if (typeof content === "string" && content.length > 0) {
            if (!ttftRecorded) {
              ttftRecorded = true;
              recordTimeToFirstToken(deployment, logFields.callStartTime);
            }
            send(transcript.add(content));
          }
        }

        // No finish_reason or [DONE] means the backend stream was truncated, matching the chat path.
        if (!completed) {
          enqueueStreamErrorEvent(controller, TRUNCATED_STREAM_MESSAGE, "server_error");
          controller.close();
          recordFailedRequest(logFields);
          return;
        }

        const done: Record<string, unknown> = { type: "transcript.text.done", text: transcript.text() };
        if (usage) {
          done.usage = {
            type: "tokens",
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
          };
        }
        controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(done)}\n\n`));
        controller.close();

        recordUsage({
          ...logFields,
          usage: usage && { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens },
          logCalls: false,
        });
      } catch (e) {
        if (!isAbortError(e)) recordFailedRequest(logFields);
        handleStreamError(e, controller, log);
      } finally {
        idle?.clear();
      }
    },
  });
  return sseResponse(stream);
}

/** Catalog model type for this STT endpoint (TTS would be a separate `speech` type). */
export const TRANSCRIPTION_MODEL_TYPE = "transcription";

/**
 * OpenAI-compatible `/v1/audio/transcriptions`. Multipart (the audio file), so
 * it resolves the model from the form rather than the JSON `resolveModel` path.
 */
export async function handleTranscription(req: Request): Promise<Response> {
  const callStartTime = Date.now();
  let leased: FailedRequestContext | undefined;
  let routed: BackendRoute | undefined;

  // Counts a failure against the leased node, except 499 (client disconnect).
  const noteFailedRequest = (res: Response): Response => {
    if (leased && res.status >= 400 && res.status !== 499) {
      recordFailedRequest(leased);
    }
    return res;
  };

  try {
    if (req.method !== "POST") {
      return errorResponse("Method not allowed", 405);
    }

    const auth = await resolveAuth(req);
    if (auth instanceof Response) {
      return auth;
    }

    const form = await req.formData().catch(() => null);
    if (!form) {
      return errorResponse("Expected a multipart/form-data body", 400);
    }

    const originalModel = form.get("model");
    if (typeof originalModel !== "string" || originalModel.length === 0) {
      return errorResponse("Missing or invalid 'model' field", 400);
    }
    if (!(form.get("file") instanceof Blob)) {
      return errorResponse("Missing 'file' field", 400);
    }

    const lookup = await getModelInfo(auth.orgId, originalModel);
    if (lookup.status !== "found") {
      return modelLookupFailureResponse(lookup.status);
    }
    const modelInfo = lookup.info;
    releaseCallbacks.set(req, modelInfo.release);
    leased = { auth, modelInfo, callStartTime };
    routed = modelInfo;

    const typeError = validateModelType(modelInfo, [TRANSCRIPTION_MODEL_TYPE]);
    if (typeError) {
      return noteFailedRequest(typeError);
    }

    const wantsStream = form.get("stream") === "true" || form.get("stream") === "1";
    const diarizing = modelInfo.tags?.includes(DIARIZATION_TAG) ?? false;
    const diarized = form.get("response_format") === DIARIZED_FORMAT;
    if (diarized && !diarizing) {
      return noteFailedRequest(errorResponse(`Model '${originalModel}' does not support response_format '${DIARIZED_FORMAT}'`, 400));
    }
    // The OpenAI SDKs send array fields as `name[]`.
    const knownSpeakerField = KNOWN_SPEAKER_FIELDS.find((field) => form.has(field) || form.has(`${field}[]`));
    if (knownSpeakerField) {
      return noteFailedRequest(errorResponse(`Model '${originalModel}' does not support '${knownSpeakerField}'`, 400));
    }

    form.set("model", modelInfo.model);
    if (wantsStream) {
      form.set("stream", "true");
      form.set("stream_include_usage", "true");
      // vLLM streams only plain text, so a diarized stream is built here from the model's markup.
      if (diarized) {
        form.set("response_format", "json");
      }
    }

    // `as FormData` bridges the global vs undici FormData type mismatch.
    const idle = wantsStream ? createIdleTimeout() : undefined;
    const timeoutSignal = idle?.signal ?? AbortSignal.timeout(config.inference.backendTimeoutMs());
    const signal = AbortSignal.any([req.signal, timeoutSignal]);
    const backendResponse = await backendPostForm(modelInfo, "/v1/audio/transcriptions", form as FormData, signal);
    if (!backendResponse.ok) {
      return noteFailedRequest(await forwardBackendError(backendResponse, log, modelInfo));
    }

    if (wantsStream) {
      return streamTranscriptionAsOpenAI(backendResponse, { auth, modelInfo, callStartTime }, originalModel, diarizing ? segmentedTranscript(diarized) : plainTranscript(), idle);
    }

    const contentType = backendResponse.headers.get("content-type") ?? "application/json";
    const raw = await backendResponse.text();
    const body = diarized ? withOpenAISpeakers(raw) : diarizing ? plainBody(raw, contentType.includes("application/json")) : raw;
    recordUsage({
      usage: contentType.includes("application/json") ? tokenUsageOf(body) : undefined,
      auth,
      modelInfo,
      callStartTime,
      logCalls: false,
    });

    return new Response(body, {
      status: backendResponse.status,
      headers: { "Content-Type": contentType },
    });
  } catch (error) {
    return noteFailedRequest(handleEndpointError(error, log, routed));
  }
}
