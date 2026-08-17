import { describe, test, expect, mock } from "bun:test";
import type { AuditEvent } from "common-db";
import { buildPushPayload, deliverAuditEvents } from "./audit-loki";

const event: AuditEvent = {
  id: "3f1d1c2e-0000-4000-8000-000000000001",
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

describe("buildPushPayload", () => {
  test("labels the stream by action, resource and result only", () => {
    const payload = JSON.parse(buildPushPayload([event]));
    expect(payload.streams[0].stream).toEqual({
      job: "xinity-audit",
      action: "apiKey.create",
      resource: "apiKey",
      result: "success",
    });
  });

  test("carries the whole event in the line at a nanosecond timestamp", () => {
    const [timestamp, line] = JSON.parse(buildPushPayload([event])).streams[0].values[0];
    expect(timestamp).toBe(`${event.createdAt.getTime()}000000`);
    expect(JSON.parse(line)).toMatchObject({ id: event.id, actorLabel: "jv@xinity.ai", context: { name: "prod" } });
  });

  test("collapses events sharing a label set into one stream", () => {
    const payload = JSON.parse(buildPushPayload([event, { ...event, id: "second", resourceId: "key_2" }]));
    expect(payload.streams).toHaveLength(1);
    expect(payload.streams[0].values).toHaveLength(2);
  });

  test("keeps events with differing labels in separate streams", () => {
    const payload = JSON.parse(buildPushPayload([event, { ...event, id: "second", result: "failure" }]));
    expect(payload.streams).toHaveLength(2);
    expect(payload.streams.map((s: { stream: { result: string } }) => s.stream.result).sort()).toEqual(["failure", "success"]);
  });
});

describe("deliverAuditEvents", () => {
  test("posts to the push endpoint of the configured base URL", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("", { status: 204 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const delivery = await deliverAuditEvents([event], {
      url: "http://localhost:6122/",
      auth: "user:pass",
      tenant: "acme",
    });

    expect(delivery).toEqual({ delivered: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:6122/loki/api/v1/push");
    expect((init.headers as Record<string, string>)["X-Scope-OrgID"]).toBe("acme");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("user:pass")}`);
  });

  test("omits auth headers when the target has no credentials", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("", { status: 204 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await deliverAuditEvents([event], { url: "http://localhost:6122" });

    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["X-Scope-OrgID"]).toBeUndefined();
  });

  test("reports a rejected push instead of throwing", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("entry too far behind", { status: 400 }))) as unknown as typeof fetch;

    expect(await deliverAuditEvents([event], { url: "http://localhost:6122" })).toEqual({
      delivered: false,
      reason: "400 entry too far behind",
    });
  });

  test("does not call out for an empty batch", async () => {
    const fetchMock = mock(() => Promise.reject(new Error("should not be called")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await deliverAuditEvents([], { url: "http://localhost:6122" })).toEqual({ delivered: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("reports a transport failure instead of throwing", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;

    expect(await deliverAuditEvents([event], { url: "http://localhost:6122" })).toEqual({
      delivered: false,
      reason: "connection refused",
    });
  });
});
