import { describe, test, expect, mock, jest, beforeEach } from "bun:test";
import { drizzle, chatMessageT, type ApiCallInputMessage } from "common-db";
import { jsonDigest } from "common-env";

const db = drizzle.mock();

type CapturedQuery = { sql: string; params: unknown[] };
const capturedQueries: CapturedQuery[] = [];

let insertedRows: Array<{ id: string; sha256: string }> = [];
/** Stands in for content another call stored first. */
let existingRows: Array<{ id: string; sha256: string }> = [];

const preparedProto = Object.getPrototypeOf(db.select().from(chatMessageT).prepare("_spy"));
jest.spyOn(preparedProto, "execute").mockImplementation(async function (this: { queryString: string; params: unknown[] }) {
  capturedQueries.push({ sql: this.queryString, params: this.params });
  return /^\s*insert/i.test(this.queryString) ? insertedRows : existingRows;
});

mock.module("./db", () => ({ getDB: () => db }));

const { recordChatMessages } = await import("./chat-message-store");

const insertQueries = () => capturedQueries.filter((q) => /^\s*insert/i.test(q.sql));
const selectQueries = () => capturedQueries.filter((q) => /^\s*select/i.test(q.sql));

/** Distinct per test, since the digest cache is module-level. */
let orgCounter = 0;
function freshOrg(): string {
  orgCounter += 1;
  return `org-${orgCounter}`;
}

beforeEach(() => {
  capturedQueries.length = 0;
  insertedRows = [];
  existingRows = [];
});

// What the store must treat as the same message, and what it must keep apart. The digest itself
// is covered in common-env; these cover the message shapes the gateway actually sends.
describe("message identity", () => {
  test("ignores key order, inside the message and inside its content parts", () => {
    const a = { role: "user", content: [{ type: "text", text: "Hi" }] } as ApiCallInputMessage;
    const b = { content: [{ text: "Hi", type: "text" }], role: "user" } as ApiCallInputMessage;
    expect(jsonDigest(a)).toBe(jsonDigest(b));
  });

  // Merging them would make one row serve both forms, and the second caller would read back a
  // payload it never sent.
  test("keeps an absent field distinct from an empty one", () => {
    const base = { role: "assistant", content: "Hi" } as ApiCallInputMessage;
    const empty = { role: "assistant", content: "Hi", tool_calls: [] } as ApiCallInputMessage;
    expect(jsonDigest(base)).not.toBe(jsonDigest(empty));
  });

  test("distinguishes the same content in a different role", () => {
    const a = { role: "user", content: "Hi" } as ApiCallInputMessage;
    const b = { role: "assistant", content: "Hi" } as ApiCallInputMessage;
    expect(jsonDigest(a)).not.toBe(jsonDigest(b));
  });

  test("distinguishes tool results by their call id", () => {
    const a = { role: "tool", content: "42", tool_call_id: "call_a" } as ApiCallInputMessage;
    const b = { role: "tool", content: "42", tool_call_id: "call_b" } as ApiCallInputMessage;
    expect(jsonDigest(a)).not.toBe(jsonDigest(b));
  });

  test("distinguishes messages differing only in a field the type does not model", () => {
    const anna = { role: "user", content: "Hi", name: "anna" } as unknown as ApiCallInputMessage;
    const bob = { role: "user", content: "Hi", name: "bob" } as unknown as ApiCallInputMessage;
    const plain = { role: "user", content: "Hi" } as ApiCallInputMessage;
    expect(jsonDigest(anna)).not.toBe(jsonDigest(bob));
    expect(jsonDigest(anna)).not.toBe(jsonDigest(plain));
  });

  test("distinguishes assistant messages differing only in engine reasoning output", () => {
    const plain = { role: "assistant", content: "42" } as ApiCallInputMessage;
    const reasoned = { role: "assistant", content: "42", reasoning_content: "thinking" } as unknown as ApiCallInputMessage;
    expect(jsonDigest(plain)).not.toBe(jsonDigest(reasoned));
  });

  test("deduplicates multimodal messages by their stored media reference", () => {
    const parts = (url: string) => [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url } },
    ];
    const first = { role: "user", content: parts("xinity-media://abc") } as ApiCallInputMessage;
    const second = { role: "user", content: parts("xinity-media://abc") } as ApiCallInputMessage;
    const other = { role: "user", content: parts("xinity-media://def") } as ApiCallInputMessage;

    expect(jsonDigest(first)).toBe(jsonDigest(second));
    expect(jsonDigest(first)).not.toBe(jsonDigest(other));
  });

  test("distinguishes content part types it does not model", () => {
    const audio = {
      role: "user",
      content: [{ type: "input_audio", input_audio: { data: "AAA", format: "wav" } }],
    } as unknown as ApiCallInputMessage;
    const file = {
      role: "user",
      content: [{ type: "file", file: { file_id: "f_1" } }],
    } as unknown as ApiCallInputMessage;

    expect(jsonDigest(audio)).not.toBe(jsonDigest(file));
  });
});

describe("recordChatMessages", () => {
  const system = { role: "system", content: "You are helpful" } as ApiCallInputMessage;
  const user = { role: "user", content: "Hi" } as ApiCallInputMessage;

  test("returns an empty list without touching the database", async () => {
    expect(await recordChatMessages(freshOrg(), [])).toEqual([]);
    expect(capturedQueries).toHaveLength(0);
  });

  test("inserts new messages and returns their ids in input order", async () => {
    insertedRows = [
      { id: "id-system", sha256: jsonDigest(system) },
      { id: "id-user", sha256: jsonDigest(user) },
    ];

    const ids = await recordChatMessages(freshOrg(), [system, user]);

    expect(ids).toEqual(["id-system", "id-user"]);
    expect(insertQueries()).toHaveLength(1);
    expect(selectQueries()).toHaveLength(0);
  });

  test("sends the digest it computed, so the row is addressed by content", async () => {
    insertedRows = [{ id: "id-system", sha256: jsonDigest(system) }];

    await recordChatMessages(freshOrg(), [system]);

    expect(insertQueries()[0]?.params).toContain(jsonDigest(system));
  });

  test("reads back rows that conflicted instead of updating them", async () => {
    insertedRows = [];
    existingRows = [{ id: "id-existing", sha256: jsonDigest(system) }];

    const ids = await recordChatMessages(freshOrg(), [system]);

    expect(ids).toEqual(["id-existing"]);
    const [insert] = insertQueries();
    expect(insert?.sql).toContain("on conflict do nothing");
    expect(insert?.sql).not.toContain("do update");
    expect(selectQueries()).toHaveLength(1);
  });

  test("collapses a message repeated within one batch to a single insert", async () => {
    insertedRows = [{ id: "id-user", sha256: jsonDigest(user) }];

    const ids = await recordChatMessages(freshOrg(), [user, user, user]);

    expect(ids).toEqual(["id-user", "id-user", "id-user"]);
    expect(insertQueries()).toHaveLength(1);
    const [insert] = insertQueries();
    expect(insert?.params.filter((p) => p === jsonDigest(user))).toHaveLength(1);
  });

  test("collapses two spellings of one message to a single insert", async () => {
    const reordered = { content: "Hi", role: "user" } as ApiCallInputMessage;
    insertedRows = [{ id: "id-user", sha256: jsonDigest(user) }];

    const ids = await recordChatMessages(freshOrg(), [user, reordered]);

    expect(ids).toEqual(["id-user", "id-user"]);
    expect(insertQueries()[0]?.params.filter((p) => p === jsonDigest(user))).toHaveLength(1);
  });

  test("serves a repeated message from cache without a second round trip", async () => {
    const orgId = freshOrg();
    insertedRows = [{ id: "id-system", sha256: jsonDigest(system) }];
    await recordChatMessages(orgId, [system]);
    capturedQueries.length = 0;

    const ids = await recordChatMessages(orgId, [system]);

    expect(ids).toEqual(["id-system"]);
    expect(capturedQueries).toHaveLength(0);
  });

  test("does not serve one organization's message from another's cache entry", async () => {
    const digest = jsonDigest(system);
    insertedRows = [{ id: "id-org-a", sha256: digest }];
    await recordChatMessages(freshOrg(), [system]);
    capturedQueries.length = 0;

    insertedRows = [{ id: "id-org-b", sha256: digest }];
    const ids = await recordChatMessages(freshOrg(), [system]);

    expect(ids).toEqual(["id-org-b"]);
    expect(insertQueries()).toHaveLength(1);
  });

  test("stores the message verbatim, including unmodelled fields", async () => {
    const named = { role: "user", content: "Hi", name: "anna" } as unknown as ApiCallInputMessage;
    insertedRows = [{ id: "id-named", sha256: jsonDigest(named) }];

    await recordChatMessages(freshOrg(), [named]);

    const [insert] = insertQueries();
    const payload = insert?.params.find((p) => typeof p === "string" && p.includes("anna"));
    expect(payload).toBeDefined();
    expect(JSON.parse(payload as string)).toEqual({ role: "user", content: "Hi", name: "anna" });
  });

  test("routes queries through a supplied transaction", async () => {
    insertedRows = [{ id: "id-system", sha256: jsonDigest(system) }];
    const tx = { insert: jest.fn(db.insert.bind(db)), select: jest.fn(db.select.bind(db)) };

    const ids = await recordChatMessages(freshOrg(), [system], tx as never);

    expect(ids).toEqual(["id-system"]);
    expect(tx.insert).toHaveBeenCalledTimes(1);
  });

  test("throws when a message can be neither inserted nor found", async () => {
    insertedRows = [];
    existingRows = [];
    await expect(recordChatMessages(freshOrg(), [system])).rejects.toThrow("Failed to record message");
  });
});
