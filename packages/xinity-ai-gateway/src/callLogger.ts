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
  } catch (batchErr) {
    log.warn({ err: batchErr, count: batch.length }, "API call batch insert failed, falling back to individual inserts");
    for (const row of batch) {
      try {
        await getDB().insert(apiCallT).values(row);
      } catch (rowErr) {
        log.error({ err: rowErr, specifiedModel: row.specifiedModel, organizationId: row.organizationId }, "DB error writing individual API call");
      }
    }
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

export async function logChatSync(input: ChatSyncInput) {
  const rows = input.data.choices.map((choice) =>
    buildApiCallRow(input, input.data.model, toOutputMessage(choice.message)),
  );
  if (rows.length === 0) {
    return;
  }
  await insertApiCallRows(rows);
}

export async function logChatStream(input: ChatStreamInput) {
  const rows = input.data.flatMap((entry) =>
    entry.choices.map((choice) => buildApiCallRow(input, entry.model, toOutputMessage(choice.delta))),
  );
  if (rows.length === 0) {
    return;
  }
  await insertApiCallRows(rows);
}
