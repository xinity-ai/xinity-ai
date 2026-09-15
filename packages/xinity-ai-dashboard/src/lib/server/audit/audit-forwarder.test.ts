import { describe, test, expect, beforeEach, afterAll, mock, spyOn } from "bun:test";
import type { AuditEvent } from "common-db";
import * as auditLoki from "./audit-loki";
import * as auditSyslog from "./audit-syslog";
import type { DashboardConfig } from "../config-schema";

/**
 * Spies rather than `mock.module`, which has no counterpart to undo it: the
 * override would outlive this file and hand the sink suites the stub in place
 * of the module they exist to test.
 */
const lokiSink = spyOn(auditLoki, "lokiSink");
const syslogSink = spyOn(auditSyslog, "syslogSink");

afterAll(() => {
  lokiSink.mockRestore();
  syslogSink.mockRestore();
});

const { resolveAuditSink, forwardAuditEvent, flushAuditEvents } = await import("./audit-forwarder");

const { config } = require("$lib/server/config") as { config: DashboardConfig };
const licensedFeatures = (require("$lib/server/license") as { licensedFeatures: string[] }).licensedFeatures;

const deliver = mock((_events: AuditEvent[]): Promise<void> => Promise.resolve());

function audit(url: string): DashboardConfig["audit"] {
  return { url, facility: "local0", framing: "octet-counting", appName: "xinity-audit" };
}

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "3f1d1c2e-0000-4000-8000-000000000001",
    streamPosition: 1,
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
  config.audit = audit("http://localhost:6122");
  lokiSink.mockReturnValue({ name: "loki", deliver });
  syslogSink.mockReturnValue({ name: "syslog", deliver });
  await flushAuditEvents();
  deliver.mockClear();
  deliver.mockImplementation(() => Promise.resolve());
});

describe("resolveAuditSink", () => {
  test("is null when no sink is configured", () => {
    config.audit = undefined;
    expect(resolveAuditSink()).toBeNull();
  });

  test("is null without the audit-log feature", () => {
    licensedFeatures.length = 0;
    expect(resolveAuditSink()).toBeNull();
  });

  test("picks the sink from the url scheme", () => {
    for (const url of ["http://localhost:6122", "https://loki.example.com"]) {
      config.audit = audit(url);
      expect(resolveAuditSink()?.name).toBe("loki");
    }
    for (const url of ["udp://collector:514", "tcp://collector:514", "tls://collector:6514"]) {
      config.audit = audit(url);
      expect(resolveAuditSink()?.name).toBe("syslog");
    }
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
    config.audit = undefined;
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
