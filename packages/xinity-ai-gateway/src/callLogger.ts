import type { ApiCallInputMessage, InferenceEndpoint } from "common-db";
import { recordInferenceCalls, type InferenceCallRecord } from "./inference-call-store";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "call-logger" });

export type ChatSyncData = {
  model: string;
  choices: Array<{
    index: number;
    message: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
};

export type ChatStreamData = Array<{
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
}>;

type ChatLogFields = {
  keyId: string;
  applicationId: string | null;
  organizationId: string;
  durationInMS: number;
  publicSpecifier: string;
  servedModel: string;
  endpoint: InferenceEndpoint;
  /** Reserved by a surface that had to record the id before the call was logged. */
  inferenceCallId?: string | null;
  inputMessages: ApiCallInputMessage[];
  metadata?: Record<string, unknown>;
};

type ChatSyncInput = ChatLogFields & { data: ChatSyncData };
type ChatStreamInput = ChatLogFields & { data: ChatStreamData };

// Characters that PostgreSQL cannot store in text/jsonb columns.
// U+0000 (null) is the only codepoint PostgreSQL categorically rejects.
const PG_UNSAFE_CHAR = /\0/g;

function containsNullByte(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\0");
  if (Array.isArray(value)) return value.some(containsNullByte);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsNullByte);
  }
  return false;
}

function sanitizeForPg(value: unknown): unknown {
  // Fast path: if no null bytes present, return value untouched without object cloning
  if (!containsNullByte(value)) return value;

  if (typeof value === "string") {
    return value.replace(PG_UNSAFE_CHAR, "");
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForPg);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeForPg(v);
    }
    return out;
  }
  return value;
}

const CALL_BATCH_SIZE = 50;
const CALL_FLUSH_INTERVAL_MS = 200;

let callQueue: InferenceCallRecord[] = [];
let callTimer: ReturnType<typeof setTimeout> | null = null;

export async function flushCallLog(): Promise<void> {
  if (callTimer) {
    clearTimeout(callTimer);
    callTimer = null;
  }
  if (callQueue.length === 0) return;

  const batch = callQueue;
  callQueue = [];

  await recordInferenceCalls(batch)
    .catch((err) => log.error({ err, count: batch.length }, "Inference call batch insert failed"));
}

async function enqueueCalls(calls: InferenceCallRecord[]): Promise<void> {
  callQueue.push(...calls);
  if (callQueue.length >= CALL_BATCH_SIZE) {
    void flushCallLog();
  } else if (!callTimer) {
    callTimer = setTimeout(() => void flushCallLog(), CALL_FLUSH_INTERVAL_MS);
  }
}

process.on("beforeExit", () => {
  void flushCallLog();
});

function coerceMessageRole(raw: unknown): ApiCallInputMessage["role"] {
  return ((raw as string) || "assistant") as ApiCallInputMessage["role"];
}

/** vLLM and DeepSeek send `reasoning_content`, other engines `reasoning`. */
function normalizeReasoning(msg: Record<string, unknown>): Record<string, unknown> {
  const { reasoning, ...rest } = msg;
  if (typeof reasoning === "string" && rest.reasoning_content === undefined) {
    return { ...rest, reasoning_content: reasoning };
  }
  return rest;
}

/** Backend schemas are loose, so rebuilding would drop fields: `ApiCallInputMessage` is a lower
 * bound on what is stored. */
function toOutputMessage(msg: Record<string, unknown>): ApiCallInputMessage {
  return {
    ...normalizeReasoning(msg),
    role: coerceMessageRole(msg.role),
    content: (msg.content as string | null) ?? "",
  } as ApiCallInputMessage;
}

function buildRecord(
  input: ChatLogFields,
  outputMessage: ApiCallInputMessage,
  choiceIndex: number,
): InferenceCallRecord {
  return {
    // Only the first choice can claim it: every choice is its own call row.
    id: choiceIndex === 0 ? input.inferenceCallId ?? undefined : undefined,
    organizationId: input.organizationId,
    apiKeyId: input.keyId,
    applicationId: input.applicationId,
    endpoint: input.endpoint,
    servedModel: input.servedModel,
    publicSpecifier: input.publicSpecifier,
    durationMs: input.durationInMS,
    metadata: input.metadata ? sanitizeForPg(input.metadata) as Record<string, unknown> : undefined,
    inputMessages: sanitizeForPg(input.inputMessages) as ApiCallInputMessage[],
    outputMessages: [sanitizeForPg(outputMessage) as ApiCallInputMessage],
  };
}

export async function logChatSync(input: ChatSyncInput) {
  const calls = input.data.choices.map((choice, index) =>
    buildRecord(input, toOutputMessage(choice.message), index),
  );
  if (calls.length === 0) {
    return;
  }
  await enqueueCalls(calls);
}

export async function logChatStream(input: ChatStreamInput) {
  const calls = input.data.flatMap((entry) =>
    entry.choices.map((choice) => buildRecord(input, toOutputMessage(choice.delta), choice.index)),
  );
  if (calls.length === 0) {
    return;
  }
  await enqueueCalls(calls);
}
