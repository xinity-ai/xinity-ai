import { z } from "zod";
import {
  errorResponse,
  handleStreamError,
  logChatUsage,
  readSSEStream,
  SSE_RESPONSE_HEADERS,
  sseEncoder,
} from "./util";
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
  modelInfo: { model: string };
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
};

export function forwardOpenAIStream<Chunk extends StreamChunkLike, Acc>({
  backendResponse,
  originalModel,
  spec,
  logFields,
  log,
}: {
  backendResponse: Response;
  originalModel: string;
  spec: StreamSpec<Chunk, Acc>;
  logFields: OpenAIForwardLogFields;
  log: Logger;
}): Response {
  let collectedUsage: z.infer<typeof BackendUsageSchema> | undefined;
  const accumByChoice = new Map<number, Acc>();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of readSSEStream(backendResponse)) {
          if (event.data === "[DONE]") {
            controller.enqueue(sseEncoder.encode("data: [DONE]\n\n"));
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
            log.warn({ issues: parsed.error.issues }, "Malformed backend SSE chunk, skipping");
            continue;
          }
          const chunk = { ...parsed.data, model: originalModel };

          if (chunk.usage) {
            collectedUsage = chunk.usage;
          }
          if (chunk.choices.length) {
            for (const choice of chunk.choices) {
              let acc = accumByChoice.get(choice.index);
              if (!acc) {
                acc = spec.initAcc();
                accumByChoice.set(choice.index, acc);
              }
              spec.applyChoice(acc, choice);
            }
          }

          controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.close();

        const outputData: ChatStreamData = [...accumByChoice.entries()]
          .sort(([a], [b]) => a - b)
          .map(([idx, acc]) => spec.toLogEntry(acc, idx, originalModel));

        logChatUsage({
          ...logFields,
          usage: collectedUsage,
          outputData,
          stream: true,
        });
      } catch (e) {
        handleStreamError(e, controller, log);
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
