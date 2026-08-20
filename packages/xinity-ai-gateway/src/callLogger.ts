import { getDB } from "./db";
import { apiCallT, type ApiCallInputMessage } from "common-db";
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
  inputMessages: ApiCallInputMessage[];
  metadata?: Record<string, unknown>;
};

type ChatSyncInput = ChatLogFields & { data: ChatSyncData };
type ChatStreamInput = ChatLogFields & { data: ChatStreamData };

type ApiCallRow = ReturnType<typeof buildApiCallRow>;

function buildApiCallRow(input: ChatLogFields, model: string, outputMessage: ApiCallInputMessage) {
  return {
    apiKeyId: input.keyId,
    applicationId: input.applicationId,
    organizationId: input.organizationId,
    specifiedModel: input.publicSpecifier,
    duration: input.durationInMS,
    model,
    outputMessage,
    inputMessages: input.inputMessages,
    metadata: input.metadata,
  };
}

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

function sanitizeRow(row: ApiCallRow): ApiCallRow {
  return {
    ...row,
    inputMessages: sanitizeForPg(row.inputMessages) as ApiCallRow["inputMessages"],
    outputMessage: sanitizeForPg(row.outputMessage) as ApiCallRow["outputMessage"],
    metadata: row.metadata ? sanitizeForPg(row.metadata) as ApiCallRow["metadata"] : row.metadata,
  };
}

const CALL_BATCH_SIZE = 50;
const CALL_FLUSH_INTERVAL_MS = 200;

let callQueue: ApiCallRow[] = [];
let callTimer: ReturnType<typeof setTimeout> | null = null;

export async function flushApiCallRows(): Promise<void> {
  if (callTimer) {
    clearTimeout(callTimer);
    callTimer = null;
  }
  if (callQueue.length === 0) return;

  const batch = callQueue;
  callQueue = [];

  try {
    await getDB().insert(apiCallT).values(batch);
  } catch (err) {
    log.error({ err, count: batch.length }, "DB error writing API call batch");
  }
}

async function insertApiCallRows(rows: ApiCallRow[]): Promise<void> {
  for (const row of rows) {
    callQueue.push(sanitizeRow(row));
  }
  if (callQueue.length >= CALL_BATCH_SIZE) {
    void flushApiCallRows();
  } else if (!callTimer) {
    callTimer = setTimeout(() => void flushApiCallRows(), CALL_FLUSH_INTERVAL_MS);
  }
}

process.on("beforeExit", () => {
  void flushApiCallRows();
});

function coerceMessageRole(raw: unknown): ApiCallInputMessage["role"] {
  return ((raw as string) || "assistant") as ApiCallInputMessage["role"];
}

function syncMessageToOutput(msg: Record<string, unknown>): ApiCallInputMessage {
  const outputMessage: ApiCallInputMessage = {
    role: coerceMessageRole(msg.role),
    content: (msg.content as string | null) ?? "",
  };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    outputMessage.tool_calls = msg.tool_calls as ApiCallInputMessage["tool_calls"];
  }
  return outputMessage;
}

function streamChunksToOutput(data: ChatStreamData, choiceIndex: number): ApiCallInputMessage {
  const content = data
    .map((chunk) => chunk.choices[choiceIndex]?.delta.content as string | undefined)
    .filter((c) => c)
    .join("");
  const role = coerceMessageRole(data[0]?.choices[choiceIndex]?.delta.role);
  const outputMessage: ApiCallInputMessage = { content, role };
  const toolCalls = data
    .map((chunk) => chunk.choices[choiceIndex]?.delta.tool_calls)
    .find((tc) => Array.isArray(tc) && tc.length > 0);
  if (toolCalls) {
    outputMessage.tool_calls = toolCalls as ApiCallInputMessage["tool_calls"];
  }
  return outputMessage;
}

export async function logChatSync(input: ChatSyncInput) {
  if (!input.data.choices.length) return;
  const rows = input.data.choices.map((choice) =>
    buildApiCallRow(input, input.data.model, syncMessageToOutput(choice.message)),
  );
  await insertApiCallRows(rows);
}

export async function logChatStream(input: ChatStreamInput) {
  const firstChunk = input.data[0];
  if (!firstChunk || !firstChunk.choices.length) return;
  const rows = firstChunk.choices.map((_, choiceIndex) =>
    buildApiCallRow(input, firstChunk.model, streamChunksToOutput(input.data, choiceIndex)),
  );
  await insertApiCallRows(rows);
}
