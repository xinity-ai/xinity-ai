import type { z } from "zod";
import {
  backendFailureMessage,
  enqueueStreamErrorEvent,
  errorResponse,
  forwardBackendError,
  handleStreamError,
  isAbortError,
  logChatUsage,
  readSSEStream,
  recordFailedRequest,
  recordUsage,
  TRUNCATED_STREAM_MESSAGE,
  sseEncoder,
  sseResponse,
  type BackendRoute,
} from "./util";
import { recordBackendError, recordTimeToFirstToken } from "../metrics";
import { BackendUsageSchema } from "./backend-schemas";
import type { CallLogFields } from "./usage";
import type { ChatStreamData, ChatSyncData } from "../callLogger";
import type { Logger } from "common-log";


type StreamChunkLike = {
  choices: Array<{ index: number }>;
  model: string;
  usage?: z.infer<typeof BackendUsageSchema>;
};

export type StreamSpec<Chunk extends StreamChunkLike, Acc> = {
  chunkSchema: z.ZodType<Chunk>;
  initAcc: () => Acc;
  applyChoice: (acc: Acc, choice: Chunk["choices"][number]) => void;
  toLogEntry: (acc: Acc, index: number, model: string) => ChatStreamData[number];
  /** Terminal chunk to emit when the upstream omitted a finish_reason. */
  synthesizeFinal?: (acc: Acc, index: number, template: Chunk) => Chunk | null;
};

function isValidUsage(usage: unknown): boolean {
  if (typeof usage !== "object" || usage === null) return false;
  const u = usage as Record<string, unknown>;
  return (
    typeof u.prompt_tokens === "number" &&
    typeof u.completion_tokens === "number" &&
    typeof u.total_tokens === "number"
  );
}

export function isStandardStreamingChunk(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  const obj = json as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.created !== "number") return false;
  if (!Array.isArray(obj.choices)) return false;

  if (obj.choices.length === 0) {
    return !obj.usage || isValidUsage(obj.usage);
  }

  if (obj.usage && !isValidUsage(obj.usage)) {
    return false;
  }

  for (const choice of obj.choices) {
    if (typeof choice !== "object" || choice === null) return false;
    const c = choice as Record<string, unknown>;
    if (typeof c.index !== "number") return false;

    if ("delta" in c) {
      if (typeof c.delta !== "object" || c.delta === null) return false;
      const delta = c.delta as Record<string, unknown>;
      if (delta.tool_calls !== undefined || delta.refusal !== undefined) return false;
      if (delta.content !== undefined && delta.content !== null && typeof delta.content !== "string") return false;
      if (delta.role !== undefined && typeof delta.role !== "string") return false;
      if (delta.reasoning_content !== undefined && delta.reasoning_content !== null && typeof delta.reasoning_content !== "string") return false;
      if (delta.reasoning !== undefined && typeof delta.reasoning !== "string") return false;
    } else if ("text" in c) {
      if (typeof c.text !== "string") return false;
    } else {
      return false;
    }
  }

  return true;
}

type BackendStreamError = { code: number | undefined; message: string; param: string | null };

function backendStreamError(json: unknown): BackendStreamError | undefined {
  const error = (json as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const { code, message, param } = error as { code?: unknown; message?: unknown; param?: unknown };
  return {
    code: typeof code === "number" ? code : undefined,
    message: typeof message === "string" ? message : "Backend reported an error",
    param: typeof param === "string" ? param : null,
  };
}

// A 4xx describes the caller's own request. Anything else may carry engine internals, so it stays in the log.
function isCausedByRequest(error: BackendStreamError): boolean {
  return error.code !== undefined && error.code >= 400 && error.code < 500;
}

export function forwardOpenAIStream<Chunk extends StreamChunkLike, Acc>({
  backendResponse,
  originalModel,
  spec,
  includeUsage,
  logFields,
  log,
  onStreamChunk,
  onStreamEnd,
}: {
  backendResponse: Response;
  originalModel: string;
  spec: StreamSpec<Chunk, Acc>;
  includeUsage: boolean;
  logFields: CallLogFields;
  log: Logger;
  onStreamChunk?: () => void;
  onStreamEnd?: () => void;
}): Response {
  let collectedUsage: z.infer<typeof BackendUsageSchema> | undefined;
  let backendError: BackendStreamError | undefined;
  let sawDone = false;
  let ttftRecorded = false;
  const accumByChoice = new Map<number, Acc>();

  const stream = new ReadableStream({
    async start(controller) {
      let lastChunk: Chunk | undefined;
      try {
        for await (const event of readSSEStream(backendResponse)) {
          onStreamChunk?.();
          if (event.data === "[DONE]") {
            sawDone = true;
            break;
          }

          let json: unknown;
          try {
            json = JSON.parse(event.data);
          } catch {
            log.warn({ data: event.data }, "Non-JSON SSE chunk from backend, skipping");
            continue;
          }

          backendError = backendStreamError(json);
          if (backendError !== undefined) {
            break;
          }

          let chunk: Chunk;
          // Fast-path: Standard SSE chunk envelope with verified choices shape
          if (isStandardStreamingChunk(json)) {
            const rawObj = json as Record<string, unknown>;
            rawObj.model = originalModel;
            chunk = rawObj as unknown as Chunk;
          } else {
            // Fallback: Validate via full Zod schema
            const parsed = spec.chunkSchema.safeParse(json);
            if (!parsed.success) {
              // Forward chunks we can't model instead of dropping them; they skip logging only.
              log.warn({ issues: parsed.error.issues }, "Unrecognized backend SSE chunk, forwarding unlogged");
              if (json && typeof json === "object") {
                (json as Record<string, unknown>).model = originalModel;
              }
              controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(json)}\n\n`));
              continue;
            }
            chunk = { ...parsed.data, model: originalModel };
          }
          lastChunk = chunk;

          if (!ttftRecorded) {
            ttftRecorded = true;
            recordTimeToFirstToken(logFields.publicSpecifier, logFields.callStartTime);
          }

          if (chunk.usage) {
            collectedUsage = chunk.usage;
          }
          for (const choice of chunk.choices) {
            let acc = accumByChoice.get(choice.index);
            if (!acc) {
              acc = spec.initAcc();
              accumByChoice.set(choice.index, acc);
            }
            spec.applyChoice(acc, choice);
          }

          if (!includeUsage && chunk.choices.length === 0 && chunk.usage) {
            continue;
          }
          const forwarded = includeUsage ? chunk : { ...chunk, usage: undefined };
          controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(forwarded)}\n\n`));
        }

        if (backendError !== undefined) {
          const { model, nodeId } = logFields.modelInfo;
          recordBackendError(model, backendError.code ?? 500);
          recordFailedRequest(logFields);
          if (isCausedByRequest(backendError)) {
            log.warn({ model: originalModel, backendError }, "Backend rejected the request mid-stream");
            enqueueStreamErrorEvent(controller, backendError.message, "invalid_request_error", backendError.param);
          } else {
            const reference = crypto.randomUUID();
            log.error({ model: originalModel, nodeId, reference, backendError }, "Backend failed mid-stream");
            enqueueStreamErrorEvent(controller, backendFailureMessage(reference), "server_error");
          }
          controller.close();
          return;
        }

        const sortedAccs = [...accumByChoice.entries()].sort(([a], [b]) => a - b);

        if (sawDone) {
          // Backfill a finish_reason the backend never sent.
          if (spec.synthesizeFinal && lastChunk) {
            for (const [index, acc] of sortedAccs) {
              const extra = spec.synthesizeFinal(acc, index, lastChunk);
              if (extra) controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(extra)}\n\n`));
            }
          }
          controller.enqueue(sseEncoder.encode("data: [DONE]\n\n"));
        } else {
          // Upstream ended without the [DONE] sentinel: the backend died
          // mid-stream and delivered a truncated response.
          enqueueStreamErrorEvent(controller, TRUNCATED_STREAM_MESSAGE, "server_error");
        }
        controller.close();

        if (!sawDone) {
          log.error({ model: originalModel }, "Backend stream ended without [DONE]");
          recordFailedRequest(logFields);
          return;
        }

        const outputData: ChatStreamData = sortedAccs.map(([idx, acc]) => spec.toLogEntry(acc, idx, originalModel));

        logChatUsage({
          ...logFields,
          usage: collectedUsage,
          outputData,
          stream: true,
        });
      } catch (e) {
        // The 200 header is already sent, so the endpoint guard can't see this
        // failure; record it here. Client aborts don't count against the node.
        if (!isAbortError(e)) {
          recordFailedRequest(logFields);
        }
        handleStreamError(e, controller, log);
      } finally {
        onStreamEnd?.();
      }
    },
  });

  return sseResponse(stream);
}

export type NonStreamSpec<Choice> = {
  choicesSchema: z.ZodType<Choice[]>;
  toLogOutput: (choices: Choice[], model: string) => ChatSyncData;
};

export async function forwardOpenAINonStream<Choice>({
  backendResponse,
  originalModel,
  spec,
  logFields,
  log,
}: {
  backendResponse: Response;
  originalModel: string;
  spec: NonStreamSpec<Choice>;
  logFields: CallLogFields;
  log: Logger;
}): Promise<Response> {
  let raw: Record<string, unknown>;
  try {
    raw = await backendResponse.json() as Record<string, unknown>;
  } catch {
    return errorResponse("Backend returned an invalid response", 502);
  }
  raw.model = originalModel;

  const choicesResult = spec.choicesSchema.safeParse(raw.choices);
  const usageResult = BackendUsageSchema.safeParse(raw.usage);
  const usage = usageResult.success ? usageResult.data : undefined;
  if (choicesResult.success) {
    logChatUsage({
      ...logFields,
      usage,
      outputData: spec.toLogOutput(choicesResult.data, originalModel),
      stream: false,
    });
  } else {
    log.warn({ issues: choicesResult.error.issues }, "Could not extract choices for logging");
    recordUsage({ ...logFields, usage, logCalls: false, deployment: logFields.publicSpecifier });
  }
  return Response.json(raw);
}

export function forwardOpenAIResponse<Chunk extends StreamChunkLike, Acc, Choice>({
  backendResponse,
  originalModel,
  stream,
  includeUsage,
  streamSpec,
  nonStreamSpec,
  logFields,
  route,
  log,
  onStreamChunk,
  onStreamEnd,
}: {
  backendResponse: Response;
  originalModel: string;
  stream: boolean;
  includeUsage: boolean;
  streamSpec: StreamSpec<Chunk, Acc>;
  nonStreamSpec: NonStreamSpec<Choice>;
  logFields: CallLogFields;
  route: BackendRoute & { model: string };
  log: Logger;
  onStreamChunk?: () => void;
  onStreamEnd?: () => void;
}): Response | Promise<Response> {
  if (!backendResponse.ok) {
    onStreamEnd?.();
    return forwardBackendError(backendResponse, log, route);
  }
  if (stream) {
    return forwardOpenAIStream({ backendResponse, originalModel, includeUsage, spec: streamSpec, logFields, log, onStreamChunk, onStreamEnd });
  }
  onStreamEnd?.();
  return forwardOpenAINonStream({ backendResponse, originalModel, spec: nonStreamSpec, logFields, log });
}
