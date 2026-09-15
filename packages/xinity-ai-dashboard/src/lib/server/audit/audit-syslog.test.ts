import { describe, test, expect } from "bun:test";
import type { AuditEvent } from "common-db";
import { buildSyslogMessage, framePayload, parseSyslogUrl, sendToSyslog, type SyslogConfig } from "./audit-syslog";

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

function config(overrides: Partial<SyslogConfig> = {}): SyslogConfig {
  return {
    transport: "tcp",
    host: "127.0.0.1",
    port: 514,
    facility: "local0",
    framing: "octet-counting",
    appName: "xinity-audit",
    source: "host1",
    ...overrides,
  };
}

function parts(message: string) {
  const [priVersion, timestamp, source, appName, procid, msgid, structuredData, ...rest] = message.split(" ");
  return { priVersion, timestamp, source, appName, procid, msgid, structuredData, payload: rest.join(" ") };
}

describe("parseSyslogUrl", () => {
  test("defaults tls to 6514 and the plaintext transports to 514", () => {
    expect(parseSyslogUrl("tls://collector.example.com")).toEqual({ transport: "tls", host: "collector.example.com", port: 6514 });
    expect(parseSyslogUrl("tcp://collector.example.com")).toEqual({ transport: "tcp", host: "collector.example.com", port: 514 });
    expect(parseSyslogUrl("udp://collector.example.com")).toEqual({ transport: "udp", host: "collector.example.com", port: 514 });
  });

  test("keeps an explicit port", () => {
    expect(parseSyslogUrl("tcp://collector.example.com:1514").port).toBe(1514);
  });
});

describe("buildSyslogMessage", () => {
  test("derives the priority from the facility and the result", () => {
    expect(parts(buildSyslogMessage(event, config())).priVersion).toBe("<134>1");
    expect(parts(buildSyslogMessage({ ...event, result: "failure" }, config())).priVersion).toBe("<132>1");
    expect(parts(buildSyslogMessage(event, config({ facility: "audit" }))).priVersion).toBe("<110>1");
    expect(parts(buildSyslogMessage(event, config({ facility: "kern" }))).priVersion).toBe("<6>1");
  });

  test("fills the header from the event and the config", () => {
    const header = parts(buildSyslogMessage(event, config({ appName: "acme-audit" })));
    expect(header.timestamp).toBe("2026-08-16T10:00:00.000Z");
    expect(header.source).toBe("host1");
    expect(header.appName).toBe("acme-audit");
    expect(header.procid).toBe(String(process.pid));
    expect(header.msgid).toBe("apiKey.create");
    expect(header.structuredData).toBe("-");
  });

  test("carries the whole event as JSON in the message", () => {
    expect(JSON.parse(parts(buildSyslogMessage(event, config())).payload)).toMatchObject({
      id: event.id,
      streamPosition: event.streamPosition,
      actorLabel: "jv@xinity.ai",
      context: { name: "prod" },
    });
  });

  test("caps the msgid at the 32 characters the grammar allows", () => {
    const message = buildSyslogMessage({ ...event, action: "instanceAdmin.remove_user_from_org" }, config());
    expect(parts(message).msgid).toBe("instanceAdmin.remove_user_from_o");
  });

  test("drops context rather than emitting an oversized line", () => {
    const bloated = { ...event, context: { blob: "x".repeat(2_000) } };
    const payload = JSON.parse(parts(buildSyslogMessage(bloated, config({ transport: "udp" }))).payload);
    expect(payload).toMatchObject({ id: event.id, context: null, truncated: "context" });
  });

  test("falls back to an identifying payload when even the context-free event is too long", () => {
    const bloated = { ...event, userAgent: "x".repeat(2_000), context: { blob: "y".repeat(2_000) } };
    const payload = JSON.parse(parts(buildSyslogMessage(bloated, config({ transport: "udp" }))).payload);
    expect(payload).toEqual({
      id: event.id,
      action: event.action,
      result: event.result,
      createdAt: event.createdAt.toISOString(),
      truncated: "event",
    });
  });

  test("keeps every transport's line within its budget", () => {
    const bloated = { ...event, context: { blob: "x".repeat(20_000) } };
    expect(Buffer.byteLength(buildSyslogMessage(bloated, config({ transport: "udp" })))).toBeLessThanOrEqual(1400);
    expect(Buffer.byteLength(buildSyslogMessage(bloated, config({ transport: "tcp" })))).toBeLessThanOrEqual(8192);
  });
});

describe("framePayload", () => {
  test("prefixes each message with its byte length", () => {
    expect(new TextDecoder().decode(framePayload(["abc", "de"], "octet-counting"))).toBe("3 abc2 de");
  });

  test("counts bytes rather than characters", () => {
    expect(new TextDecoder().decode(framePayload(["é"], "octet-counting"))).toBe("2 é");
  });

  test("delimits with newlines when the collector wants lf framing", () => {
    expect(new TextDecoder().decode(framePayload(["abc", "de"], "lf"))).toBe("abc\nde\n");
  });
});

describe("sendToSyslog", () => {
  test("writes the framed batch to a tcp collector", async () => {
    const chunks: Uint8Array[] = [];
    const received = Promise.withResolvers<void>();
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data: (_socket, chunk) => {
          chunks.push(chunk);
        },
        close: () => received.resolve(),
      },
    });

    await sendToSyslog([event, { ...event, id: "second" }], config({ port: server.port }));
    await received.promise;
    server.stop();

    const text = Buffer.concat(chunks).toString();
    expect(text.match(/^\d+ <134>1 /)).not.toBeNull();
    expect(text.split("<134>1 ")).toHaveLength(3);
  });

  test("sends one datagram per event to a udp collector", async () => {
    const datagrams: string[] = [];
    const received = Promise.withResolvers<void>();
    const server = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data: (_socket, data) => {
          datagrams.push(data.toString());
          if (datagrams.length === 2) {
            received.resolve();
          }
        },
      },
    });

    await sendToSyslog([event, { ...event, id: "second" }], config({ transport: "udp", port: server.port }));
    await received.promise;
    server.close();

    expect(datagrams).toHaveLength(2);
    expect(datagrams[0]).toStartWith("<134>1 2026-08-16T10:00:00.000Z host1 xinity-audit ");
  });

  test("rejects when nothing is listening", async () => {
    const idle = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
    const { port } = idle;
    idle.stop(true);

    await expect(sendToSyslog([event], config({ port }))).rejects.toThrow();
  });
});
