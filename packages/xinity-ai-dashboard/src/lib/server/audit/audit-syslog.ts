import { hostname } from "node:os";
import { SYSLOG_FACILITIES, type Audit } from "$lib/server/config-schema";
import type { AuditEvent } from "common-db";
import type { AuditSink } from "./audit-sink";

const SEND_TIMEOUT_MS = 5_000;
/** RFC 5425 assigns 6514 to syslog over TLS. Plain syslog keeps the traditional 514. */
const DEFAULT_PORT = { udp: 514, tcp: 514, tls: 6514 } as const;
/** A datagram has to survive a 1500-byte path MTU intact. A stream can afford rsyslog's 8k default. */
const MAX_MESSAGE_BYTES = { udp: 1400, tcp: 8192, tls: 8192 } as const;
/** RFC 5424 severities: informational for a success, warning for a failure. */
const SEVERITY = { success: 6, failure: 4 } as const;
/** The RFC 5424 grammar caps MSGID at 32 characters. */
const MSGID_MAX_CHARS = 32;

export type SyslogTransport = keyof typeof DEFAULT_PORT;
export type SyslogFraming = "octet-counting" | "lf";

export type SyslogConfig = {
  transport: SyslogTransport;
  host: string;
  port: number;
  ca?: string;
  facility: (typeof SYSLOG_FACILITIES)[number];
  framing: SyslogFraming;
  appName: string;
  source: string;
};

const encoder = new TextEncoder();

export function parseSyslogUrl(raw: string): { transport: SyslogTransport; host: string; port: number } {
  const url = new URL(raw);
  const transport = url.protocol.replace(":", "") as SyslogTransport;
  return { transport, host: url.hostname, port: url.port ? Number(url.port) : DEFAULT_PORT[transport] };
}

/** HOSTNAME and APP-NAME are space-delimited PRINTUSASCII fields, so anything else would break the frame. */
function printableAscii(value: string): string {
  return value.replace(/[^\x21-\x7e]/g, "") || "-";
}

/**
 * Fits the event into what is left of the message budget, degrading in steps that
 * each stay valid JSON: a byte-truncated line would be unparseable to the collector,
 * and `id` is enough to pull the untruncated row back out of audit_event. Every step
 * keeps `streamPosition`.
 */
function fitPayload(event: AuditEvent, budget: number): string {
  const full = JSON.stringify(event);
  if (Buffer.byteLength(full) <= budget) {
    return full;
  }
  const withoutContext = JSON.stringify({ ...event, context: null, truncated: "context" });
  if (Buffer.byteLength(withoutContext) <= budget) {
    return withoutContext;
  }
  return JSON.stringify({
    id: event.id,
    streamPosition: event.streamPosition,
    action: event.action,
    result: event.result,
    createdAt: event.createdAt,
    truncated: "event",
  });
}

/**
 * One RFC 5424 message carrying the event as JSON in MSG and no structured data,
 * so a collector parses this and the Loki mirror with the same rule.
 */
export function buildSyslogMessage(event: AuditEvent, config: SyslogConfig): string {
  const priority = SYSLOG_FACILITIES.indexOf(config.facility) * 8 + SEVERITY[event.result];
  const msgid = printableAscii(event.action).slice(0, MSGID_MAX_CHARS);
  const header = `<${priority}>1 ${event.createdAt.toISOString()} ${config.source} ${config.appName} ${process.pid} ${msgid} - `;
  return header + fitPayload(event, MAX_MESSAGE_BYTES[config.transport] - header.length);
}

export function framePayload(messages: string[], framing: SyslogFraming): Uint8Array {
  const frames = messages.map((message) => {
    const bytes = encoder.encode(message);
    if (framing === "lf") {
      return encoder.encode(`${message}\n`);
    }
    const prefix = encoder.encode(`${bytes.length} `);
    const frame = new Uint8Array(prefix.length + bytes.length);
    frame.set(prefix);
    frame.set(bytes, prefix.length);
    return frame;
  });

  const payload = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    payload.set(frame, offset);
    offset += frame.length;
  }
  return payload;
}

async function sendDatagrams(messages: string[], config: SyslogConfig): Promise<void> {
  const socket = await Bun.udpSocket({ connect: { hostname: config.host, port: config.port } });
  try {
    const sent = socket.sendMany(messages);
    if (sent < messages.length) {
      throw new Error(`sent ${sent} of ${messages.length} datagrams`);
    }
  } finally {
    socket.close();
  }
}

/**
 * Opens a connection per batch rather than holding one open. At a flush every five
 * seconds the handshake is free, and it keeps the sink stateless: no reconnect
 * backoff, no half-open detection, nothing to leak between flushes.
 */
function sendStream(payload: Uint8Array, config: SyslogConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    let written = 0;
    let settled = false;

    const settle = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => settle(new Error(`timed out after ${SEND_TIMEOUT_MS}ms`)), SEND_TIMEOUT_MS);

    const pump = (socket: Bun.Socket) => {
      while (written < payload.length) {
        const flushed = socket.write(payload, written);
        if (flushed <= 0) {
          return;
        }
        written += flushed;
      }
      socket.end();
      settle();
    };

    Bun.connect({
      hostname: config.host,
      port: config.port,
      tls: config.transport === "tls" ? (config.ca ? { ca: config.ca } : true) : undefined,
      socket: {
        open: pump,
        drain: pump,
        error: (_socket, err) => settle(err),
        close: () => settle(written < payload.length ? new Error("collector closed the connection before the batch was written") : undefined),
      },
    }).catch((err: unknown) => settle(err instanceof Error ? err : new Error(String(err))));
  });
}

export async function sendToSyslog(events: AuditEvent[], config: SyslogConfig): Promise<void> {
  const messages = events.map(event => buildSyslogMessage(event, config));
  if (config.transport === "udp") {
    await sendDatagrams(messages, config);
    return;
  }
  await sendStream(framePayload(messages, config.framing), config);
}

export function syslogSink(settings: Audit): AuditSink {
  const config: SyslogConfig = {
    ...parseSyslogUrl(settings.url),
    ca: settings.ca,
    facility: settings.facility,
    framing: settings.framing,
    appName: printableAscii(settings.appName),
    source: printableAscii(hostname()),
  };
  return { name: "syslog", deliver: events => sendToSyslog(events, config) };
}
