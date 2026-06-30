import { z } from "zod";
import {
  errorResponse,
  forwardBackendError,
  handleStreamError,
  isAbortError,
  logChatUsage,
  readSSEStream,
  recordFailedRequest,
  SSE_RESPONSE_HEADERS,
  sseEncoder,
} from "./util";
import { recordTimeToFirstToken } from "../metrics";
import { BackendUsageSchema } from "./backend-schemas";
import type { AuthResult } from "./auth";
import type { ApiCallInputMessage } from "common-db";
import type { ChatStreamData, ChatSyncData } from "../callLogger";

type Logger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export type OpenAIForwardLogFields = {
  auth: AuthResult;
  modelInfo: { model: string; nodeId?: string | null };
  modelSpecifier: string;
  inputMessages: ApiCallInputMessage[];
  callStartTime: number;
  logCalls?: boolean;
  metadata?: Record<string, unknown>;
};

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

export function forwardOpenAIStream<Chunk extends StreamChunkLike, Acc>({
  backendResponse,
  originalModel,
  spec,
  logFields,
  log,
  onStreamChunk,
  onStreamEnd,
}: {
  backendResponse: Response;
  originalModel: string;
  spec: StreamSpec<Chunk, Acc>;
  logFields: OpenAIForwardLogFields;
  log: Logger;
  onStreamChunk?: () => void;
  onStreamEnd?: () => void;
}): Response {
  let collectedUsage: z.infer<typeof BackendUsageSchema> | undefined;
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
          const chunk = { ...parsed.data, model: originalModel };
          lastChunk = chunk;

          if (!ttftRecorded) {
            ttftRecorded = true;
            recordTimeToFirstToken(logFields.modelSpecifier, logFields.callStartTime);
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

          controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
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
        }
        controller.close();

        if (!sawDone) {
          // Upstream ended without the [DONE] sentinel: the backend died
          // mid-stream and delivered a truncated response.
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

  return new Response(stream, { headers: SSE_RESPONSE_HEADERS });
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
  logFields: OpenAIForwardLogFields;
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
  if (choicesResult.success) {
    logChatUsage({
      ...logFields,
      usage: usageResult.success ? usageResult.data : undefined,
      outputData: spec.toLogOutput(choicesResult.data, originalModel),
      stream: false,
    });
  } else {
    log.warn({ issues: choicesResult.error.issues }, "Could not extract choices for logging");
  }
  return Response.json(raw);
}

export function forwardOpenAIResponse<Chunk extends StreamChunkLike, Acc, Choice>({
  backendResponse,
  originalModel,
  stream,
  streamSpec,
  nonStreamSpec,
  logFields,
  log,
  onStreamChunk,
  onStreamEnd,
}: {
  backendResponse: Response;
  originalModel: string;
  stream: boolean;
  streamSpec: StreamSpec<Chunk, Acc>;
  nonStreamSpec: NonStreamSpec<Choice>;
  logFields: OpenAIForwardLogFields;
  log: Logger;
  onStreamChunk?: () => void;
  onStreamEnd?: () => void;
}): Response | Promise<Response> {
  if (!backendResponse.ok) {
    onStreamEnd?.();
    return forwardBackendError(backendResponse, log);
  }
  if (stream) {
    return forwardOpenAIStream({ backendResponse, originalModel, spec: streamSpec, logFields, log, onStreamChunk, onStreamEnd });
  }
  onStreamEnd?.();
  return forwardOpenAINonStream({ backendResponse, originalModel, spec: nonStreamSpec, logFields, log });
}
