import { describe, test, expect, mock, jest, beforeEach } from "bun:test";
import { drizzle, inferenceCallT, type ApiCallInputMessage } from "common-db";
import { jsonDigest } from "common-env";

const db = drizzle.mock();
/** drizzle.mock() has no client to begin a transaction on, so run the body inline. */
(db as unknown as { transaction: unknown }).transaction = async (run: (tx: typeof db) => unknown) => run(db);

type CapturedQuery = { sql: string; params: unknown[] };
const capturedQueries: CapturedQuery[] = [];

let messageRows: Array<{ id: string; sha256: string }> = [];

const preparedProto = Object.getPrototypeOf(db.select().from(inferenceCallT).prepare("_spy"));
jest.spyOn(preparedProto, "execute").mockImplementation(async function (this: { queryString: string; params: unknown[] }) {
  capturedQueries.push({ sql: this.queryString, params: this.params });
  return this.queryString.includes("chat_message") ? messageRows : [];
});

mock.module("./db", () => ({ getDB: () => db }));

const { recordInferenceCalls } = await import("./inference-call-store");

/** Matches the quoted identifier, so `inference_call` does not also match its message table. */
const insertsInto = (table: string) =>
  capturedQueries.filter((q) => /^\s*insert/i.test(q.sql) && q.sql.includes(`"${table}"`));
const messageInsert = () => insertsInto("inference_call_message")[0];

/** Distinct per test, since the digest cache is module-level. */
let orgCounter = 0;
function freshOrg(): string {
  orgCounter += 1;
  return `infcall-org-${orgCounter}`;
}

const user = (content: string) => ({ role: "user", content }) as ApiCallInputMessage;
const assistant = (content: string) => ({ role: "assistant", content }) as ApiCallInputMessage;

/** Every message the batch will resolve, in the order the store asks for them per org. */
function resolveTo(...messages: ApiCallInputMessage[]) {
  messageRows = messages.map((message, index) => ({ id: `msg-${index}`, sha256: jsonDigest(message) }));
}

function call(orgId: string, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: orgId,
    apiKeyId: "key-1",
    applicationId: "app-1",
    endpoint: "chat_completions" as const,
    model: "engine-model",
    specifiedModel: "public-model",
    durationMs: 120,
    inputMessages: [user("Hi")],
    outputMessages: [assistant("Hello")],
    ...overrides,
  };
}

beforeEach(() => {
  capturedQueries.length = 0;
  messageRows = [];
});

describe("recordInferenceCalls", () => {
  test("numbers each call's conversation from zero and marks which end it came from", async () => {
    const orgId = freshOrg();
    const input = [user("u1"), assistant("a1"), user("u2")];
    const output = [assistant("a2")];
    resolveTo(...input, ...output);

    await recordInferenceCalls([call(orgId, { inputMessages: input, outputMessages: output })]);

    const params = messageInsert()?.params ?? [];
    expect(params.filter((p) => p === "input")).toHaveLength(3);
    expect(params.filter((p) => p === "output")).toHaveLength(1);
    // The reply continues the input's numbering rather than restarting, which would collide
    // with it on the (call_id, seq) key.
    expect(params.filter((p) => typeof p === "number")).toEqual([0, 1, 2, 3]);
  });

  test("writes the whole batch in one insert per table", async () => {
    const orgId = freshOrg();
    resolveTo(user("Hi"), assistant("Hello"));

    await recordInferenceCalls([call(orgId), call(orgId)]);

    expect(insertsInto("inference_call")).toHaveLength(1);
    expect(insertsInto("inference_call_message")).toHaveLength(1);
  });

  test("resolves each organization's messages separately, since the corpus is org-scoped", async () => {
    const orgA = freshOrg();
    const orgB = freshOrg();
    resolveTo(user("Hi"), assistant("Hello"));

    await recordInferenceCalls([call(orgA), call(orgB)]);

    expect(insertsInto("chat_message")).toHaveLength(2);
  });

  test("writes a header and nothing else for a surface that carries no messages", async () => {
    await recordInferenceCalls([
      call(freshOrg(), { endpoint: "embeddings", inputMessages: [], outputMessages: [] }),
    ]);

    expect(capturedQueries).toHaveLength(1);
    expect(messageInsert()).toBeUndefined();
  });

  test("defaults absent metadata to an empty object", async () => {
    await recordInferenceCalls([call(freshOrg(), { inputMessages: [], outputMessages: [] })]);

    expect(capturedQueries[0]?.params).toContain("{}");
  });

  test("touches the database not at all for an empty batch", async () => {
    expect(await recordInferenceCalls([])).toEqual([]);
    expect(capturedQueries).toHaveLength(0);
  });
});
