import { createCounter, createGauge, createHistogram, createMetricsAuth, serializeMetrics } from "common-env";
import { env } from "./env";

const metricsAuth = createMetricsAuth(env.METRICS_AUTH);

const connectedNodes = createGauge(
  "tether_connected_nodes",
  "Daemons currently holding an SSE connection.",
);

const sseConnectionsTotal = createCounter(
  "tether_sse_connections_total",
  "SSE connections established.",
);

// A healthy daemon connection lasts as long as the node is up, so every
// observation below a few minutes is a reconnect worth explaining. The low
// boundaries carry the diagnostic weight; the high ones only need to separate
// "hours" from "days".
const CONNECTION_DURATION_BUCKETS = [1, 5, 15, 30, 60, 300, 900, 3600, 21600, 86400];

const connectionDuration = createHistogram(
  "tether_sse_connection_duration_seconds",
  "How long each closed SSE connection lasted, by the reason it closed.",
  CONNECTION_DURATION_BUCKETS,
);

const desiredStatePushesTotal = createCounter(
  "tether_desired_state_pushes_total",
  "Desired-state events pushed to daemons.",
);

const requestRejectionsTotal = createCounter(
  "tether_request_rejections_total",
  "Daemon requests refused before doing any work, by endpoint and reason.",
);

export type DisconnectReason =
  | "cancel"
  | "superseded"
  | "write_failed"
  | "keepalive_failed"
  | "liveness_timeout"
  | "shutdown";

export type RejectionReason =
  | "unauthorized"
  | "invalid_payload"
  | "protocol_mismatch"
  | "registration_failed"
  | "method_not_allowed";

export function incSSEConnections() {
  sseConnectionsTotal.inc({});
}

export function observeConnectionDuration(reason: DisconnectReason, seconds: number) {
  connectionDuration.observe({ reason }, seconds);
}

export function incDesiredStatePushes() {
  desiredStatePushesTotal.inc({});
}

export function setConnectedNodes(n: number) {
  connectedNodes.set({}, n);
}

export function incRequestRejections(endpoint: "stream" | "status", reason: RejectionReason) {
  requestRejectionsTotal.inc({ endpoint, reason });
}

// Publish the label-free series from the first scrape on, so a freshly started
// tether reads as zero rather than "no data".
connectedNodes.set({}, 0);
sseConnectionsTotal.inc({}, 0);
desiredStatePushesTotal.inc({}, 0);

const allMetrics = [
  connectedNodes,
  sseConnectionsTotal,
  connectionDuration,
  desiredStatePushesTotal,
  requestRejectionsTotal,
];

export function handleMetrics(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const authErr = metricsAuth.unauthorized(req.headers.get("authorization"));
  if (authErr) {
    return authErr;
  }

  return new Response(serializeMetrics(allMetrics), {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
