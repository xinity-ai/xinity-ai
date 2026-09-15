import { describe, test, expect, afterEach, mock } from "bun:test";
import type { AuditEvent } from "common-db";
import { buildPushPayload, pushToLoki } from "./audit-loki";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const event: AuditEvent = {
  id: "3f1d1c2e-0000-4000-8000-000000000001",
  streamPosition: 4211,
  organizationId: "org_1",
  actorType: "user",
  actorId: "user_1",
  actorLabel: "jv@xinity.ai",
  action: "apiKey.create",
  resource: "apiKey",
  resourceId: "key_1",
  result: "success",
  ipAddress: "203.0.113.7",
  userAgent: "curl/8.0",
  context: { name: "prod" },
  createdAt: new Date("2026-08-16T10:00:00.000Z"),
};

function mockFetch(response: () => Promise<Response>) {
  const fetchMock = mock(response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function headersOf(fetchMock: ReturnType<typeof mockFetch>): Record<string, string> {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return init.headers as Record<string, string>;
}

describe("buildPushPayload", () => {
  test("labels the stream by instance, action, resource and result only", () => {
    const payload = JSON.parse(buildPushPayload([event], "host1"));
    expect(payload.streams[0].stream).toEqual({
      job: "xinity-audit",
      instance: "host1",
      action: "apiKey.create",
      resource: "apiKey",
      result: "success",
    });
  });

  test("keeps instances apart so their positions are not interleaved", () => {
    const one = JSON.parse(buildPushPayload([event], "host1")).streams[0].stream.instance;
    const two = JSON.parse(buildPushPayload([event], "host2")).streams[0].stream.instance;
    expect([one, two]).toEqual(["host1", "host2"]);
  });

  test("carries the whole event in the line at a nanosecond timestamp", () => {
    const [timestamp, line] = JSON.parse(buildPushPayload([event], "host1")).streams[0].values[0];
    expect(timestamp).toBe(`${event.createdAt.getTime()}000000`);
    expect(JSON.parse(line)).toMatchObject({ id: event.id, streamPosition: event.streamPosition, actorLabel: "jv@xinity.ai", context: { name: "prod" } });
  });

  test("collapses events sharing a label set into one stream", () => {
    const payload = JSON.parse(buildPushPayload([event, { ...event, id: "second", resourceId: "key_2" }], "host1"));
    expect(payload.streams).toHaveLength(1);
    expect(payload.streams[0].values).toHaveLength(2);
  });

  test("keeps events with differing labels in separate streams", () => {
    const payload = JSON.parse(buildPushPayload([event, { ...event, id: "second", result: "failure" }], "host1"));
    expect(payload.streams).toHaveLength(2);
    expect(payload.streams.map((s: { stream: { result: string } }) => s.stream.result).sort()).toEqual(["failure", "success"]);
  });
});

describe("pushToLoki", () => {
  test("posts to the push endpoint of the configured base URL", async () => {
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 204 })));

    await pushToLoki([event], { url: "http://localhost:6122/", auth: "user:pass", tenant: "acme", instance: "host1" });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:6122/loki/api/v1/push");
    expect(headersOf(fetchMock)["X-Scope-OrgID"]).toBe("acme");
    expect(headersOf(fetchMock).Authorization).toBe(`Basic ${btoa("user:pass")}`);
  });

  test("omits auth headers when the target has no credentials", async () => {
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 204 })));

    await pushToLoki([event], { url: "http://localhost:6122", instance: "host1" });

    expect(headersOf(fetchMock).Authorization).toBeUndefined();
    expect(headersOf(fetchMock)["X-Scope-OrgID"]).toBeUndefined();
  });

  test("throws the status and body of a rejected push", async () => {
    mockFetch(() => Promise.resolve(new Response("entry too far behind", { status: 400 })));

    await expect(pushToLoki([event], { url: "http://localhost:6122", instance: "host1" })).rejects.toThrow("400 entry too far behind");
  });

  test("propagates a transport failure", async () => {
    mockFetch(() => Promise.reject(new Error("connection refused")));

    await expect(pushToLoki([event], { url: "http://localhost:6122", instance: "host1" })).rejects.toThrow("connection refused");
  });
});

