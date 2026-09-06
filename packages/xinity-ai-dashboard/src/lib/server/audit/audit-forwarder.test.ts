import { describe, test, expect, beforeEach, afterAll, spyOn } from "bun:test";
import type { AuditEvent } from "common-db";
import * as auditLoki from "./audit-loki";

/**
 * A spy rather than `mock.module`, which has no counterpart to undo it: the
 * override would outlive this file and hand `audit-loki.test.ts` the stub in
 * place of the module it exists to test.
 */
const deliverAuditEvents = spyOn(auditLoki, "deliverAuditEvents");

afterAll(() => {
  deliverAuditEvents.mockRestore();
});

const { lokiTargetFromEnv, forwardAuditEvent, flushAuditEvents } = await import("./audit-forwarder");

const serverEnv = (require("$lib/server/serverenv") as { serverEnv: Record<string, unknown> }).serverEnv;
const licensedFeatures = (require("$lib/server/license") as { licensedFeatures: string[] }).licensedFeatures;

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
  serverEnv.AUDIT_LOKI_URL = "http://localhost:6122";
  delete serverEnv.AUDIT_LOKI_AUTH;
  delete serverEnv.AUDIT_LOKI_TENANT;
  await flushAuditEvents();
  deliverAuditEvents.mockClear();
  deliverAuditEvents.mockImplementation(() => Promise.resolve({ delivered: true }));
});

describe("lokiTargetFromEnv", () => {
  test("is null without a configured URL", () => {
    delete serverEnv.AUDIT_LOKI_URL;
    expect(lokiTargetFromEnv()).toBeNull();
  });

  test("is null without the audit-log feature", () => {
    licensedFeatures.length = 0;
    expect(lokiTargetFromEnv()).toBeNull();
  });

  test("carries the optional auth and tenant when set", () => {
    serverEnv.AUDIT_LOKI_AUTH = "user:pass";
    serverEnv.AUDIT_LOKI_TENANT = "acme";
    expect(lokiTargetFromEnv()).toEqual({
      url: "http://localhost:6122",
      auth: "user:pass",
      tenant: "acme",
    });
  });
});

describe("forwardAuditEvent", () => {
  test("buffers rather than delivering per event", async () => {
    forwardAuditEvent(event());
    forwardAuditEvent(event({ id: "second" }));
    expect(deliverAuditEvents).not.toHaveBeenCalled();

    await flushAuditEvents();
    expect(deliverAuditEvents).toHaveBeenCalledTimes(1);
    expect(deliverAuditEvents.mock.calls[0]![0]).toHaveLength(2);
  });

  test("flushes on its own once the batch is full", async () => {
    for (let i = 0; i < 100; i += 1) {
      forwardAuditEvent(event({ id: `event-${i}` }));
    }
    await Promise.resolve();
    expect(deliverAuditEvents).toHaveBeenCalledTimes(1);
    expect(deliverAuditEvents.mock.calls[0]![0]).toHaveLength(100);
  });

  test("drops the event entirely when no sink is configured", async () => {
    delete serverEnv.AUDIT_LOKI_URL;
    forwardAuditEvent(event());
    await flushAuditEvents();
    expect(deliverAuditEvents).not.toHaveBeenCalled();
  });

  test("drops the event entirely when the license lacks audit-log", async () => {
    licensedFeatures.length = 0;
    forwardAuditEvent(event());
    await flushAuditEvents();
    expect(deliverAuditEvents).not.toHaveBeenCalled();
  });
});

describe("flushAuditEvents", () => {
  test("does nothing on an empty buffer", async () => {
    await flushAuditEvents();
    expect(deliverAuditEvents).not.toHaveBeenCalled();
  });

  test("keeps accepting events after a failed delivery", async () => {
    deliverAuditEvents.mockImplementation(() => Promise.resolve({ delivered: false, reason: "boom" }));
    forwardAuditEvent(event());
    await flushAuditEvents();
    expect(deliverAuditEvents).toHaveBeenCalledTimes(1);

    deliverAuditEvents.mockImplementation(() => Promise.resolve({ delivered: true }));
    forwardAuditEvent(event({ id: "after-failure" }));
    await flushAuditEvents();
    expect(deliverAuditEvents).toHaveBeenCalledTimes(2);
    expect(deliverAuditEvents.mock.calls[1]![0]).toHaveLength(1);
  });

  test("does not re-send a batch that already went out", async () => {
    forwardAuditEvent(event());
    await flushAuditEvents();
    await flushAuditEvents();
    expect(deliverAuditEvents).toHaveBeenCalledTimes(1);
  });
});
