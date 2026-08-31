import { describe, test, expect, mock, jest, beforeEach } from "bun:test";
import { drizzle, apiResponseT, type ApiResponseStatus } from "common-db";
import type { OutputItem, ResponseObject } from "./schemas";

const db = drizzle.mock();
/** drizzle.mock() has no client to begin a transaction on, so run the body inline. */
(db as unknown as { transaction: unknown }).transaction = async (run: (tx: typeof db) => unknown) => run(db);

const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];
const preparedProto = Object.getPrototypeOf(db.select().from(apiResponseT).prepare("_spy"));
jest.spyOn(preparedProto, "execute").mockImplementation(async function (this: { queryString: string; params: unknown[] }) {
  capturedQueries.push({ sql: this.queryString, params: this.params });
  return [];
});

mock.module("../../db", () => ({ getDB: () => db }));

const { toResponseRow, fromResponseRow, isSettledStatus, createPersistedResponse, settlePersistedResponse, loadResponse, deletePersistedResponse } = await import("./persistence");

beforeEach(() => {
  capturedQueries.length = 0;
});

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const RESP_A = `resp_${UUID_A}`;
const RESP_B = `resp_${UUID_B}`;

const OUTPUT: OutputItem[] = [
  {
    id: "msg_1",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "Hello", annotations: [], logprobs: null }],
  },
  {
    id: "fc_1",
    type: "function_call",
    status: "completed",
    call_id: "call_abc",
    name: "get_weather",
    arguments: '{"city":"Berlin"}',
  },
] as OutputItem[];

function makeResponse(overrides: Partial<ResponseObject> = {}): ResponseObject {
  return {
    id: RESP_A,
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    completed_at: 1_700_000_005,
    error: null,
    incomplete_details: null,
    instructions: "Be brief",
    max_output_tokens: 256,
    model: "test-model",
    output: OUTPUT,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: "low", summary: null },
    store: true,
    temperature: 0.5,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 5,
      output_tokens: 7,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    user: "u_1",
    metadata: { tenant: "acme" },
    ...overrides,
  } as ResponseObject;
}

const OWNER = { orgId: "org-1", apiKeyId: "key-1", applicationId: "app-1", inferenceCallId: null };

/** The insert shape less its defaulted columns is the select shape. */
function asSelected(row: ReturnType<typeof toResponseRow>): typeof apiResponseT.$inferSelect {
  return row as typeof apiResponseT.$inferSelect;
}

function roundTrip(response: ResponseObject): ResponseObject {
  const row = toResponseRow(response, response.status as ApiResponseStatus, OWNER);
  return fromResponseRow(asSelected(row), response.output);
}

describe("isSettledStatus", () => {
  test.each(["completed", "failed", "incomplete", "cancelled"])("accepts %s", (status) => {
    expect(isSettledStatus(status)).toBe(true);
  });

  test("rejects in_progress", () => {
    expect(isSettledStatus("in_progress")).toBe(false);
  });
});

describe("row mapping", () => {
  test("round-trips a completed response unchanged", () => {
    const response = makeResponse();
    expect(roundTrip(response)).toEqual(response);
  });

  test("round-trips a failed response with its error", () => {
    const response = makeResponse({
      status: "failed",
      completed_at: null,
      output: [],
      usage: null,
      error: { code: "server_error", message: "upstream exploded" },
    });
    expect(roundTrip(response)).toEqual(response);
  });

  test("round-trips a cancelled response chained onto a previous one", () => {
    const response = makeResponse({ status: "cancelled", previous_response_id: RESP_B });
    expect(roundTrip(response)).toEqual(response);
  });

  test("stores both ids as bare uuids, prefix applied only on the way out", () => {
    const row = toResponseRow(makeResponse({ previous_response_id: RESP_B }), "completed", OWNER);
    expect(row.id).toBe(UUID_A);
    expect(row.previousResponseId).toBe(UUID_B);
  });

  test("keeps column-backed fields out of requestParams", () => {
    const row = toResponseRow(makeResponse(), "completed", OWNER);
    for (const field of ["id", "object", "created_at", "status", "completed_at", "error", "incomplete_details", "output", "usage", "model", "previous_response_id"]) {
      expect(row.requestParams).not.toHaveProperty(field);
    }
  });

  test("preserves request fields the schema does not enumerate", () => {
    const response = makeResponse({ safety_identifier: "si_1" } as Partial<ResponseObject>);
    expect(roundTrip(response)).toEqual(response);
  });

  test("preserves second-precision timestamps exactly", () => {
    const response = makeResponse({ created_at: 1_700_000_001, completed_at: 1_700_000_002 });
    const restored = roundTrip(response);
    expect(restored.created_at).toBe(1_700_000_001);
    expect(restored.completed_at).toBe(1_700_000_002);
  });
});

describe("tenancy", () => {
  test("scopes reads to the organization", async () => {
    expect(await loadResponse("org-1", RESP_A)).toBeNull();
    const [query] = capturedQueries;
    expect(query?.sql).toContain("organization_id");
    expect(query?.params).toContain("org-1");
    expect(query?.params).toContain(UUID_A);
    expect(query?.params).not.toContain(RESP_A);
  });

  test("does not read items for a response it could not find", async () => {
    await loadResponse("org-1", RESP_A);
    expect(capturedQueries).toHaveLength(1);
  });

  test("scopes deletes to the organization", async () => {
    await deletePersistedResponse("org-1", RESP_A);
    const [query] = capturedQueries;
    expect(query?.sql).toMatch(/^\s*delete/i);
    expect(query?.sql).toContain("organization_id");
    expect(query?.params).toContain("org-1");
  });
});

describe("createPersistedResponse", () => {
  test("records the row as in_progress whatever the object says", async () => {
    await createPersistedResponse({
      response: makeResponse({ status: "completed" }),
      ...OWNER,
      inputMessages: [],
    });
    const [insert] = capturedQueries;
    expect(insert?.sql).toMatch(/^\s*insert/i);
    expect(insert?.params).toContain("in_progress");
    expect(insert?.params).not.toContain("completed");
  });

  test("does not reference messages when the row already existed", async () => {
    await createPersistedResponse({
      response: makeResponse(),
      ...OWNER,
      inputMessages: [{ role: "user", content: "Hi" }],
    });
    expect(capturedQueries).toHaveLength(1);
  });
});

describe("settlePersistedResponse", () => {
  test("refuses to settle a response as in_progress", async () => {
    await expect(settlePersistedResponse("org-1", makeResponse({ status: "in_progress" })))
      .rejects.toThrow("Refusing to settle response");
    expect(capturedQueries).toHaveLength(0);
  });

  test("conditions the update on the row still being in_progress", async () => {
    await settlePersistedResponse("org-1", makeResponse());
    const [update] = capturedQueries;
    expect(update?.sql).toMatch(/^\s*update/i);
    expect(update?.sql).toContain("'in_progress'");
  });

  test("reports failure and skips item inserts when nothing was in_progress", async () => {
    expect(await settlePersistedResponse("org-1", makeResponse())).toBe(false);
    expect(capturedQueries).toHaveLength(1);
  });
});
