import { describe, test, expect, beforeEach, afterAll, mock, spyOn } from "bun:test";
import type { AuditEvent } from "common-db";
import * as auditLoki from "./audit-loki";

/**
 * A spy rather than `mock.module`, which has no counterpart to undo it: the
 * override would outlive this file and hand `audit-loki.test.ts` the stub in
 * place of the module it exists to test.
 */
const lokiSink = spyOn(auditLoki, "lokiSink");

afterAll(() => {
  lokiSink.mockRestore();
});

const { resolveAuditSinks, forwardAuditEvent, flushAuditEvents } = await import("./audit-forwarder");

const licensedFeatures = (require("$lib/server/license") as { licensedFeatures: string[] }).licensedFeatures;

const deliver = mock((_events: AuditEvent[]): Promise<void> => Promise.resolve());

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
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
    context: null,
    createdAt: new Date("2026-08-16T10:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(async () => {
  licensedFeatures.splice(0, licensedFeatures.length, "audit-log");
  lokiSink.mockReturnValue({ name: "loki", deliver });
  await flushAuditEvents();
  deliver.mockClear();
  deliver.mockImplementation(() => Promise.resolve());
});

describe("resolveAuditSinks", () => {
  test("is empty when no sink is configured", () => {
    lokiSink.mockReturnValue(null);
    expect(resolveAuditSinks()).toEqual([]);
  });

  test("is empty without the audit-log feature", () => {
    licensedFeatures.length = 0;
    expect(resolveAuditSinks()).toEqual([]);
  });

  test("names each configured sink", () => {
    expect(resolveAuditSinks().map(sink => sink.name)).toEqual(["loki"]);
  });
});

describe("forwardAuditEvent", () => {
  test("buffers rather than delivering per event", async () => {
    forwardAuditEvent(event());
    forwardAuditEvent(event({ id: "second" }));
    expect(deliver).not.toHaveBeenCalled();

    await flushAuditEvents();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]).toHaveLength(2);
  });

  test("flushes on its own once the batch is full", async () => {
    for (let i = 0; i < 100; i += 1) {
      forwardAuditEvent(event({ id: `event-${i}` }));
    }
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]).toHaveLength(100);
  });

  test("drops the event entirely when no sink is configured", async () => {
    lokiSink.mockReturnValue(null);
    forwardAuditEvent(event());
    await flushAuditEvents();
    expect(deliver).not.toHaveBeenCalled();
  });

  test("drops the event entirely when the license lacks audit-log", async () => {
    licensedFeatures.length = 0;
    forwardAuditEvent(event());
    await flushAuditEvents();
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("flushAuditEvents", () => {
  test("does nothing on an empty buffer", async () => {
    await flushAuditEvents();
    expect(deliver).not.toHaveBeenCalled();
  });

  test("swallows a throwing sink and keeps accepting events", async () => {
    deliver.mockImplementation(() => Promise.reject(new Error("connection refused")));
    forwardAuditEvent(event());
    await flushAuditEvents();
    expect(deliver).toHaveBeenCalledTimes(1);

    deliver.mockImplementation(() => Promise.resolve());
    forwardAuditEvent(event({ id: "after-failure" }));
    await flushAuditEvents();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]![0]).toHaveLength(1);
  });

  test("does not re-send a batch that already went out", async () => {
    forwardAuditEvent(event());
    await flushAuditEvents();
    await flushAuditEvents();
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
