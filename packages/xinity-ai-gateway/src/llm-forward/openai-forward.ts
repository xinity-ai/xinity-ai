import type { z } from "zod";
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
import { checkPostFlightGuard, recordPostFlightReward } from "./guardrails-hook";

type Logger = {

  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export type OpenAIForwardLogFields = {
  auth: AuthResult;
  modelInfo: { model: string; nodeId?: string | null };
  publicSpecifier: string;
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

        const prompt = extractPromptText(logFields.inputMessages);
        const streamedResponseText = sortedAccs
          .map(([_, acc]) => (typeof (acc as { content?: unknown }).content === "string" ? (acc as { content: string }).content : ""))
          .join("\n");

        if (prompt && streamedResponseText) {
          // Asynchronously perform post-flight check (records metrics / logs violations)
          void checkPostFlightGuard(originalModel, prompt, streamedResponseText);
          // Asynchronously calculate quality reward score
          void recordPostFlightReward(prompt, streamedResponseText, originalModel);
        }

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

function extractPromptText(messages?: ApiCallInputMessage[]): string {
  if (!messages || !Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      parts.push(m.content);
    }
  }
  return parts.join("\n");
}

function extractChoiceResponseText(choices: unknown[]): string {
  const parts: string[] = [];
  for (const choice of choices) {
    if (choice && typeof choice === "object") {
      if ("message" in choice && choice.message && typeof choice.message === "object" && "content" in choice.message && typeof (choice.message as { content: unknown }).content === "string") {
        parts.push((choice.message as { content: string }).content);
      } else if ("text" in choice && typeof (choice as { text: unknown }).text === "string") {
        parts.push((choice as { text: string }).text);
      }
    }
  }
  return parts.join("\n");
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
    const prompt = extractPromptText(logFields.inputMessages);
    const responseText = extractChoiceResponseText(choicesResult.data);

    if (prompt && responseText) {
      const guardVerdict = await checkPostFlightGuard(originalModel, prompt, responseText);
      if (!guardVerdict.allowed) {
        recordFailedRequest(logFields);
        return errorResponse(guardVerdict.reason ?? "Model output failed safety verification", 400);
      }
      void recordPostFlightReward(prompt, responseText, originalModel);
    }

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
    return forwardBackendError(backendResponse, log, logFields.modelInfo.model);
  }
  if (stream) {
    return forwardOpenAIStream({ backendResponse, originalModel, spec: streamSpec, logFields, log, onStreamChunk, onStreamEnd });
  }
  onStreamEnd?.();
  return forwardOpenAINonStream({ backendResponse, originalModel, spec: nonStreamSpec, logFields, log });
}
