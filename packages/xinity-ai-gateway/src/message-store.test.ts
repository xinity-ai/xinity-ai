import { describe, test, expect, mock, jest, beforeEach } from "bun:test";
import { drizzle, messageT, type ApiCallInputMessage } from "common-db";

const db = drizzle.mock();

type CapturedQuery = { sql: string; params: unknown[] };
const capturedQueries: CapturedQuery[] = [];

let insertedRows: Array<{ id: string; sha256: string }> = [];
/** Stands in for content another call stored first. */
let existingRows: Array<{ id: string; sha256: string }> = [];

const preparedProto = Object.getPrototypeOf(db.select().from(messageT).prepare("_spy"));
jest.spyOn(preparedProto, "execute").mockImplementation(async function (this: { queryString: string; params: unknown[] }) {
  capturedQueries.push({ sql: this.queryString, params: this.params });
  return /^\s*insert/i.test(this.queryString) ? insertedRows : existingRows;
});

mock.module("./db", () => ({ getDB: () => db }));

const { resolveMessageIds, messageDigest } = await import("./message-store");

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

describe("messageDigest", () => {
  test("is independent of key order", () => {
    const a = { role: "user", content: "Hi" } as ApiCallInputMessage;
    const b = { content: "Hi", role: "user" } as ApiCallInputMessage;
    expect(messageDigest(a)).toBe(messageDigest(b));
  });

  test("is independent of key order inside content parts", () => {
    const a = { role: "user", content: [{ type: "text", text: "Hi" }] } as ApiCallInputMessage;
    const b = { role: "user", content: [{ text: "Hi", type: "text" }] } as ApiCallInputMessage;
    expect(messageDigest(a)).toBe(messageDigest(b));
  });

  // Merging them would make one row serve both forms, and the second caller would read
  // back a payload it never sent.
  test("keeps an absent field distinct from an empty one", () => {
    const base = { role: "assistant", content: "Hi" } as ApiCallInputMessage;
    const empty = { role: "assistant", content: "Hi", tool_calls: [] } as ApiCallInputMessage;
    expect(messageDigest(base)).not.toBe(messageDigest(empty));
  });

  test("ignores explicitly undefined fields, which JSON cannot represent", () => {
    const base = { role: "user", content: "Hi" } as ApiCallInputMessage;
    const withUndefined = { role: "user", content: "Hi", tool_call_id: undefined } as ApiCallInputMessage;
    expect(messageDigest(base)).toBe(messageDigest(withUndefined));
  });

  test("distinguishes different content", () => {
    const a = { role: "user", content: "Hi" } as ApiCallInputMessage;
    const b = { role: "user", content: "Ho" } as ApiCallInputMessage;
    expect(messageDigest(a)).not.toBe(messageDigest(b));
  });

  test("distinguishes the same content in a different role", () => {
    const a = { role: "user", content: "Hi" } as ApiCallInputMessage;
    const b = { role: "assistant", content: "Hi" } as ApiCallInputMessage;
    expect(messageDigest(a)).not.toBe(messageDigest(b));
  });

  test("distinguishes tool results by their call id", () => {
    const a = { role: "tool", content: "42", tool_call_id: "call_a" } as ApiCallInputMessage;
    const b = { role: "tool", content: "42", tool_call_id: "call_b" } as ApiCallInputMessage;
    expect(messageDigest(a)).not.toBe(messageDigest(b));
  });

  test("distinguishes messages differing only in an unmodelled field", () => {
    const anna = { role: "user", content: "Hi", name: "anna" } as unknown as ApiCallInputMessage;
    const bob = { role: "user", content: "Hi", name: "bob" } as unknown as ApiCallInputMessage;
    expect(messageDigest(anna)).not.toBe(messageDigest(bob));
    expect(messageDigest(anna)).not.toBe(messageDigest({ role: "user", content: "Hi" } as ApiCallInputMessage));
  });

  test("distinguishes assistant messages differing only in engine reasoning output", () => {
    const plain = { role: "assistant", content: "42" } as ApiCallInputMessage;
    const reasoned = { role: "assistant", content: "42", reasoning_content: "thinking" } as unknown as ApiCallInputMessage;
    expect(messageDigest(plain)).not.toBe(messageDigest(reasoned));
  });

  test("deduplicates multimodal messages by their stored media reference", () => {
    const parts = (url: string) => [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url } },
    ];
    const first = { role: "user", content: parts("xinity-media://abc") } as ApiCallInputMessage;
    const second = { role: "user", content: parts("xinity-media://abc") } as ApiCallInputMessage;
    const other = { role: "user", content: parts("xinity-media://def") } as ApiCallInputMessage;

    expect(messageDigest(first)).toBe(messageDigest(second));
    expect(messageDigest(first)).not.toBe(messageDigest(other));
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

    expect(messageDigest(audio)).not.toBe(messageDigest(file));
  });
});

describe("resolveMessageIds", () => {
  const system = { role: "system", content: "You are helpful" } as ApiCallInputMessage;
  const user = { role: "user", content: "Hi" } as ApiCallInputMessage;

  test("returns an empty list without touching the database", async () => {
    expect(await resolveMessageIds(freshOrg(), [])).toEqual([]);
    expect(capturedQueries).toHaveLength(0);
  });

  test("inserts new messages and returns their ids in input order", async () => {
    insertedRows = [
      { id: "id-system", sha256: messageDigest(system) },
      { id: "id-user", sha256: messageDigest(user) },
    ];

    const ids = await resolveMessageIds(freshOrg(), [system, user]);

    expect(ids).toEqual(["id-system", "id-user"]);
    expect(insertQueries()).toHaveLength(1);
    expect(selectQueries()).toHaveLength(0);
  });

  test("reads back rows that conflicted instead of updating them", async () => {
    insertedRows = [];
    existingRows = [{ id: "id-existing", sha256: messageDigest(system) }];

    const ids = await resolveMessageIds(freshOrg(), [system]);

    expect(ids).toEqual(["id-existing"]);
    const [insert] = insertQueries();
    expect(insert?.sql).toContain("on conflict do nothing");
    expect(insert?.sql).not.toContain("do update");
    expect(selectQueries()).toHaveLength(1);
  });

  test("collapses a message repeated within one batch to a single insert", async () => {
    insertedRows = [{ id: "id-user", sha256: messageDigest(user) }];

    const ids = await resolveMessageIds(freshOrg(), [user, user, user]);

    expect(ids).toEqual(["id-user", "id-user", "id-user"]);
    expect(insertQueries()).toHaveLength(1);
    const [insert] = insertQueries();
    expect(insert?.params.filter((p) => p === messageDigest(user))).toHaveLength(1);
  });

  test("serves a repeated message from cache without a second round trip", async () => {
    const orgId = freshOrg();
    insertedRows = [{ id: "id-system", sha256: messageDigest(system) }];
    await resolveMessageIds(orgId, [system]);
    capturedQueries.length = 0;

    const ids = await resolveMessageIds(orgId, [system]);

    expect(ids).toEqual(["id-system"]);
    expect(capturedQueries).toHaveLength(0);
  });

  test("does not serve one organization's message from another's cache entry", async () => {
    const digest = messageDigest(system);
    insertedRows = [{ id: "id-org-a", sha256: digest }];
    await resolveMessageIds(freshOrg(), [system]);
    capturedQueries.length = 0;

    insertedRows = [{ id: "id-org-b", sha256: digest }];
    const ids = await resolveMessageIds(freshOrg(), [system]);

    expect(ids).toEqual(["id-org-b"]);
    expect(insertQueries()).toHaveLength(1);
  });

  test("stores the message verbatim, including unmodelled fields", async () => {
    const named = { role: "user", content: "Hi", name: "anna" } as unknown as ApiCallInputMessage;
    insertedRows = [{ id: "id-named", sha256: messageDigest(named) }];

    await resolveMessageIds(freshOrg(), [named]);

    const [insert] = insertQueries();
    const payload = insert?.params.find((p) => typeof p === "string" && p.includes("anna"));
    expect(payload).toBeDefined();
    expect(JSON.parse(payload as string)).toEqual({ role: "user", content: "Hi", name: "anna" });
  });

  test("routes queries through a supplied transaction", async () => {
    insertedRows = [{ id: "id-system", sha256: messageDigest(system) }];
    const tx = { insert: jest.fn(db.insert.bind(db)), select: jest.fn(db.select.bind(db)) };

    const ids = await resolveMessageIds(freshOrg(), [system], tx as never);

    expect(ids).toEqual(["id-system"]);
    expect(tx.insert).toHaveBeenCalledTimes(1);
  });

  test("throws when a message can be neither inserted nor found", async () => {
    insertedRows = [];
    existingRows = [];
    await expect(resolveMessageIds(freshOrg(), [system])).rejects.toThrow("Failed to resolve message");
  });
});
