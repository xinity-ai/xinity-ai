import { resolveAuth } from "../ai-sdk";
import { getModelInfo } from "../model-data";
import { releaseCallbacks } from "../release-registry";
import {
  errorResponse,
  forwardBackendError,
  handleEndpointError,
  handleStreamError,
  readSSEStream,
  recordUsage,
  SSE_RESPONSE_HEADERS,
  sseEncoder,
  validateModelType,
} from "../util";
import { backendPostForm } from "../backend-fetch";
import { BackendTranscriptionChunkSchema, BackendUsageSchema } from "../backend-schemas";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "handle-transcription" });

/** Translate vLLM's chat-completion-style transcription stream into OpenAI's `transcript.text.delta`/`transcript.text.done` events (no `[DONE]` sentinel). */
function streamTranscriptionAsOpenAI(
  backendResponse: Response,
  onUsage: (usage: { prompt_tokens: number; completion_tokens: number }) => void,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      let fullText = "";
      let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
      try {
        for await (const event of readSSEStream(backendResponse)) {
          if (event.data === "[DONE]") break;
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
          const content = parsed.data.choices[0]?.delta.content;
          if (typeof content === "string" && content.length > 0) {
            fullText += content;
            const delta = { type: "transcript.text.delta", delta: content };
            controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(delta)}\n\n`));
          }
        }

        const done: Record<string, unknown> = { type: "transcript.text.done", text: fullText };
        if (usage) {
          onUsage({ prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens });
          done.usage = {
            type: "tokens",
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
          };
        }
        controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(done)}\n\n`));
        controller.close();
      } catch (e) {
        handleStreamError(e, controller, log);
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
  try {
    if (req.method !== "POST") {
      return errorResponse("Method not allowed", 405);
    }

    const callStartTime = Date.now();
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

    const typeError = validateModelType(modelInfo, [TRANSCRIPTION_MODEL_TYPE]);
    if (typeError) {
      return typeError;
    }

    const wantsStream = form.get("stream") === "true" || form.get("stream") === "1";

    form.set("model", modelInfo.model);
    if (wantsStream) {
      form.set("stream", "true");
      form.set("stream_include_usage", "true");
    }

    // `as FormData` bridges the global vs undici FormData type mismatch.
    const backendResponse = await backendPostForm(modelInfo, "/v1/audio/transcriptions", form as FormData, req.signal);
    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log);
    }

    if (wantsStream) {
      return streamTranscriptionAsOpenAI(backendResponse, (usage) =>
        recordUsage({ usage, auth, modelInfo, callStartTime, logCalls: false }),
      );
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
    return handleEndpointError(error, log);
  }
}
