import { describe, test, expect, mock, jest, spyOn, beforeEach } from "bun:test";
import { redis } from "bun";
import { drizzle, apiResponseT } from "common-db";
import { MOCK_GATEWAY_ENV } from "./mock-env";
import type { ResponseObject } from "./responses/schemas";

mock.module("../env", () => ({ env: { ...MOCK_GATEWAY_ENV } }));

const noop = () => {};
const mockChild = (): Record<string, unknown> => ({ trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: mockChild });
mock.module("../logger", () => ({ rootLogger: { child: mockChild } }));

const db = drizzle.mock();
(db as unknown as { transaction: unknown }).transaction = async (run: (tx: typeof db) => unknown) => run(db);

const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];
/** Rows the next select should yield, standing in for a row Redis no longer has. */
let selectRows: unknown[] = [];
let failNextQuery = false;

const preparedProto = Object.getPrototypeOf(db.select().from(apiResponseT).prepare("_spy"));
jest.spyOn(preparedProto, "execute").mockImplementation(async function (this: { queryString: string; params: unknown[] }) {
  capturedQueries.push({ sql: this.queryString, params: this.params });
  if (failNextQuery) {
    failNextQuery = false;
    throw new Error("pg down");
  }
  if (/^\s*insert/i.test(this.queryString)) {
    return [{ id: UUID_A }];
  }
  return /^\s*select/i.test(this.queryString) ? selectRows : [];
});

mock.module("../db", () => ({ getDB: () => db }));

const { saveResponse, getResponse, deleteResponse } = await import("./response-store");

const redisGet = spyOn(redis, "get");
const redisSet = spyOn(redis, "set");
const redisDel = spyOn(redis, "del");

const sqlOf = (pattern: RegExp) => capturedQueries.filter((q) => pattern.test(q.sql));

beforeEach(() => {
  capturedQueries.length = 0;
  selectRows = [];
  failNextQuery = false;
  redisGet.mockClear().mockResolvedValue(null);
  redisSet.mockClear().mockResolvedValue("OK" as never);
  redisDel.mockClear().mockResolvedValue(1 as never);
});

const UUID_A = "11111111-1111-4111-8111-111111111111";
const RESP_A = `resp_${UUID_A}`;

function makeResponse(overrides: Partial<ResponseObject> = {}): ResponseObject {
  return {
    id: RESP_A,
    object: "response",
    created_at: 1_700_000_000,
    status: "in_progress",
    completed_at: null,
    error: null,
    incomplete_details: null,
    model: "test-model",
    previous_response_id: null,
    output: [],
    store: true,
    usage: null,
    metadata: {},
    ...overrides,
  } as ResponseObject;
}

/** What a select on the header table yields for a stored, settled response. */
function headerRow() {
  return {
    id: UUID_A,
    organizationId: "org-1",
    apiKeyId: "key-1",
    applicationId: "app-1",
    model: "test-model",
    status: "completed",
    previousResponseId: null,
    requestParams: { metadata: {}, store: true },
    error: null,
    incompleteDetails: null,
    usage: null,
    completedAt: null,
    createdAt: new Date(1_700_000_000 * 1000),
  };
}

const CREATION = { apiKeyId: "key-1", applicationId: "app-1", inputMessages: [] };

describe("saveResponse", () => {
  test("records a new response when given creation context", async () => {
    await saveResponse("org-1", RESP_A, makeResponse(), CREATION);
    expect(redisSet).toHaveBeenCalled();
    expect(sqlOf(/^\s*insert into "call_data"\."api_response"/i)).toHaveLength(1);
  });

  test("treats an in-progress write without creation context as cache-only", async () => {
    await saveResponse("org-1", RESP_A, makeResponse());
    expect(redisSet).toHaveBeenCalled();
    expect(capturedQueries).toHaveLength(0);
  });

  test.each(["completed", "failed", "incomplete", "cancelled"] as const)("settles on %s", async (status) => {
    await saveResponse("org-1", RESP_A, makeResponse({ status }));
    const updates = sqlOf(/^\s*update/i);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toContain("'in_progress'");
    expect(updates[0]?.params).toContain(status);
  });

  test("keeps a store:false response out of Postgres entirely", async () => {
    await saveResponse("org-1", RESP_A, makeResponse({ store: false }), CREATION);
    await saveResponse("org-1", RESP_A, makeResponse({ store: false, status: "completed" }));
    expect(redisSet).toHaveBeenCalledTimes(2);
    expect(capturedQueries).toHaveLength(0);
  });

  test("does not fail the write when Postgres does", async () => {
    failNextQuery = true;
    await saveResponse("org-1", RESP_A, makeResponse(), CREATION);
    expect(redisSet).toHaveBeenCalled();
  });
});

describe("getResponse", () => {
  test("serves from Redis without reading Postgres", async () => {
    const response = makeResponse({ status: "completed" });
    redisGet.mockResolvedValue(JSON.stringify(response));

    expect(await getResponse("org-1", RESP_A)).toEqual(response);
    expect(capturedQueries).toHaveLength(0);
  });

  test("falls back to Postgres once Redis has expired the entry", async () => {
    selectRows = [headerRow()];
    const recovered = await getResponse("org-1", RESP_A) as ResponseObject;

    expect(recovered?.id).toBe(RESP_A);
    expect(recovered?.status).toBe("completed");
    expect(sqlOf(/^\s*select/i).length).toBeGreaterThan(0);
  });

  test("re-caches what it recovered from Postgres", async () => {
    selectRows = [headerRow()];
    await getResponse("org-1", RESP_A);
    expect(redisSet).toHaveBeenCalled();
  });

  test("returns null when neither tier has it", async () => {
    expect(await getResponse("org-1", RESP_A)).toBeNull();
  });

  test("falls back to Postgres when the cached entry is corrupt", async () => {
    redisGet.mockResolvedValue("{not json");
    selectRows = [headerRow()];
    expect(await getResponse("org-1", RESP_A)).not.toBeNull();
  });

  test("falls back to Postgres when Redis errors", async () => {
    redisGet.mockRejectedValue(new Error("redis down"));
    selectRows = [headerRow()];
    expect(await getResponse("org-1", RESP_A)).not.toBeNull();
  });

  test("does not slide the cache expiry on read", async () => {
    redisGet.mockResolvedValue(JSON.stringify(makeResponse()));
    await getResponse("org-1", RESP_A);
    expect(redisSet).not.toHaveBeenCalled();
  });
});

describe("deleteResponse", () => {
  test("removes the response from both tiers", async () => {
    expect(await deleteResponse("org-1", RESP_A)).toBe(true);
    expect(redisDel).toHaveBeenCalled();
    expect(sqlOf(/^\s*delete/i)).toHaveLength(1);
  });
});
