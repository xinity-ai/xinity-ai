import { describe, test, expect, mock, jest, beforeEach } from "bun:test";
import { drizzle, apiResponseT, type ApiCallInputMessage } from "common-db";
import { MOCK_GATEWAY_ENV } from "../mock-env";
import { requestWithParams } from "./test-helpers";

mock.module("../../env", () => ({ env: { ...MOCK_GATEWAY_ENV } }));

const checkAuth = jest.fn(async () => ({
  orgId: "org-1",
  keyId: "key-1",
  applicationId: "app-1",
  collectData: true,
}));
mock.module("../auth", () => ({ checkAuth }));

const db = drizzle.mock();

const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];
/** Rows the join yields, newest-first or oldest-first as the query asked. */
let messageRows: Array<{ seq: number; payload: ApiCallInputMessage }> = [];
/** Whether the header lookup should find the response at all. */
let headerExists = true;

const preparedProto = Object.getPrototypeOf(db.select().from(apiResponseT).prepare("_spy"));
jest.spyOn(preparedProto, "execute").mockImplementation(async function (this: { queryString: string; params: unknown[] }) {
  capturedQueries.push({ sql: this.queryString, params: this.params });
  if (/api_response_message/i.test(this.queryString)) {
    return messageRows;
  }
  return headerExists ? [{ id: UUID_A, requestParams: {}, createdAt: new Date(0), status: "completed", completedAt: null, error: null, incompleteDetails: null, usage: null, model: "m", previousResponseId: null }] : [];
});

mock.module("../../db", () => ({ getDB: () => db }));

const { handleListInputItemsRequest } = await import("./handle-responses");

beforeEach(() => {
  capturedQueries.length = 0;
  messageRows = [];
  headerExists = true;
  checkAuth.mockClear();
});

const UUID_A = "11111111-1111-4111-8111-111111111111";
const RESP_A = `resp_${UUID_A}`;
const RESP_OTHER = "resp_99999999-9999-4999-8999-999999999999";

function listRequest(query = "", method = "GET") {
  return requestWithParams(
    new Request(`http://localhost:4000/v1/responses/${RESP_A}/input_items${query}`, {
      method,
      headers: { "Authorization": "Bearer test" },
    }),
    { responseId: RESP_A },
  );
}

const userMessage = (text: string): ApiCallInputMessage => ({ role: "user", content: text });

describe("handleListInputItemsRequest", () => {
  test("returns stored input as a list of items", async () => {
    messageRows = [{ seq: 0, payload: userMessage("Hi") }];

    const res = await handleListInputItemsRequest(listRequest());
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(body.has_more).toBe(false);
    expect(body.first_id).toBe(`msg_${RESP_A}_0`);
    expect(body.last_id).toBe(`msg_${RESP_A}_0`);
    expect(body.data).toEqual([{
      id: `msg_${RESP_A}_0`,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Hi" }],
    }]);
  });

  test("defaults to newest first", async () => {
    await handleListInputItemsRequest(listRequest());
    const [query] = capturedQueries;
    expect(query?.sql).toMatch(/desc/i);
  });

  test("orders oldest first when asked", async () => {
    await handleListInputItemsRequest(listRequest("?order=asc"));
    const [query] = capturedQueries;
    expect(query?.sql).toMatch(/asc/i);
  });

  test("asks for one row beyond the limit to decide has_more", async () => {
    await handleListInputItemsRequest(listRequest("?limit=5"));
    const [query] = capturedQueries;
    expect(query?.params).toContain(6);
  });

  test("reports has_more and trims the extra row", async () => {
    messageRows = [
      { seq: 0, payload: userMessage("one") },
      { seq: 1, payload: userMessage("two") },
    ];

    const res = await handleListInputItemsRequest(listRequest("?limit=1"));
    const body = (await res.json()) as any;
    expect(body.has_more).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  test("carries the cursor into the query", async () => {
    messageRows = [{ seq: 3, payload: userMessage("later") }];
    await handleListInputItemsRequest(listRequest(`?after=msg_${RESP_A}_2`));
    const [query] = capturedQueries;
    expect(query?.params).toContain(2);
  });

  test.each([
    ["?limit=0", "'limit' must be an integer"],
    ["?limit=101", "'limit' must be an integer"],
    ["?limit=abc", "'limit' must be an integer"],
    ["?order=sideways", "'order' must be"],
    [`?after=msg_${RESP_OTHER}_0`, "'after' is not an item"],
  ])("rejects %s", async (query, message) => {
    const res = await handleListInputItemsRequest(listRequest(query));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain(message);
  });

  test("returns an empty list rather than 404 when a stored response had no input", async () => {
    messageRows = [];
    headerExists = true;
    const res = await handleListInputItemsRequest(listRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toEqual([]);
    expect(body.first_id).toBeNull();
  });

  test("404s when the response was never stored", async () => {
    messageRows = [];
    headerExists = false;
    const res = await handleListInputItemsRequest(listRequest());
    expect(res.status).toBe(404);
  });

  test("scopes the query to the caller's organization", async () => {
    await handleListInputItemsRequest(listRequest());
    const [query] = capturedQueries;
    expect(query?.sql).toContain("organization_id");
    expect(query?.params).toContain("org-1");
  });

  test("rejects non-GET methods", async () => {
    const res = await handleListInputItemsRequest(listRequest("", "POST"));
    expect(res.status).toBe(405);
  });
});
