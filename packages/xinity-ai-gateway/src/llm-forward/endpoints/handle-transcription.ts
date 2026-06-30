import { resolveAuth } from "../ai-sdk";
import { getModelInfo } from "../model-data";
import { releaseCallbacks } from "../release-registry";
import {
  errorResponse,
  forwardBackendError,
  handleEndpointError,
  handleStreamError,
  isAbortError,
  readSSEStream,
  recordFailedRequest,
  recordUsage,
  SSE_RESPONSE_HEADERS,
  sseEncoder,
  validateModelType,
  type FailedRequestContext,
} from "../util";
import { backendPostForm, createIdleTimeout, type IdleTimeout } from "../backend-fetch";
import { env } from "../../env";
import { BackendTranscriptionChunkSchema, BackendUsageSchema } from "../backend-schemas";
import { recordTimeToFirstToken } from "../../metrics";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "handle-transcription" });

/** Translate vLLM's chat-completion-style transcription stream into OpenAI's `transcript.text.delta`/`transcript.text.done` events (no `[DONE]` sentinel). */
function streamTranscriptionAsOpenAI(
  backendResponse: Response,
  logFields: FailedRequestContext,
  deployment: string,
  idle?: IdleTimeout,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      let fullText = "";
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
            fullText += content;
            const delta = { type: "transcript.text.delta", delta: content };
            controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(delta)}\n\n`));
          }
        }

        const done: Record<string, unknown> = { type: "transcript.text.done", text: fullText };
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

        // No finish_reason or [DONE] means the backend stream was truncated, matching the chat path.
        if (!completed) {
          recordFailedRequest(logFields);
        } else if (usage) {
          recordUsage({
            ...logFields,
            usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens },
            logCalls: false,
          });
        }
      } catch (e) {
        if (!isAbortError(e)) recordFailedRequest(logFields);
        handleStreamError(e, controller, log);
      } finally {
        idle?.clear();
      }
    },
  });
  return new Response(stream, { headers: SSE_RESPONSE_HEADERS });
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

    const modelInfo = await getModelInfo(auth.orgId, originalModel, auth.keyId);
    if (!modelInfo) {
      return errorResponse("Model not found", 404);
    }
    releaseCallbacks.set(req, modelInfo.release);
    leased = { auth, modelInfo, callStartTime };

    const typeError = validateModelType(modelInfo, [TRANSCRIPTION_MODEL_TYPE]);
    if (typeError) {
      return noteFailedRequest(typeError);
    }

    const wantsStream = form.get("stream") === "true" || form.get("stream") === "1";

    form.set("model", modelInfo.model);
    if (wantsStream) {
      form.set("stream", "true");
      form.set("stream_include_usage", "true");
    }

    // `as FormData` bridges the global vs undici FormData type mismatch.
    const idle = wantsStream ? createIdleTimeout() : undefined;
    const timeoutSignal = idle?.signal ?? AbortSignal.timeout(env.BACKEND_TIMEOUT_MS);
    const signal = AbortSignal.any([req.signal, timeoutSignal]);
    const backendResponse = await backendPostForm(modelInfo, "/v1/audio/transcriptions", form as FormData, signal);
    if (!backendResponse.ok) {
      return noteFailedRequest(await forwardBackendError(backendResponse, log));
    }

    if (wantsStream) {
      return streamTranscriptionAsOpenAI(backendResponse, { auth, modelInfo, callStartTime }, originalModel, idle);
    }

    const contentType = backendResponse.headers.get("content-type") ?? "application/json";
    const body = await backendResponse.text();
    if (contentType.includes("application/json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      const usage = BackendUsageSchema.safeParse((parsed as { usage?: unknown } | undefined)?.usage);
      if (usage.success && usage.data) {
        recordUsage({
          usage: { prompt_tokens: usage.data.prompt_tokens, completion_tokens: usage.data.completion_tokens },
          auth,
          modelInfo,
          callStartTime,
          logCalls: false,
        });
      }
    }

    return new Response(body, {
      status: backendResponse.status,
      headers: { "Content-Type": contentType },
    });
  } catch (error) {
    return noteFailedRequest(handleEndpointError(error, log));
  }
}
