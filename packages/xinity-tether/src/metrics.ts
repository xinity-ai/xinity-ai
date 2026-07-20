import { createMetricsAuth } from "common-env";
import { env } from "./env";

const metricsAuth = createMetricsAuth(env.METRICS_AUTH);

let sseConnectionsTotal = 0;
let registrationWritesTotal = 0;
let stateWritesTotal = 0;
let livenessTimeoutsTotal = 0;
let desiredStatePushesTotal = 0;
let connectedNodes = 0;

export function incSSEConnections() { sseConnectionsTotal++; }
export function incRegistrationWrites() { registrationWritesTotal++; }
export function incStateWrites() { stateWritesTotal++; }
export function incLivenessTimeouts() { livenessTimeoutsTotal++; }
export function incDesiredStatePushes() { desiredStatePushesTotal++; }
export function setConnectedNodes(n: number) { connectedNodes = n; }

export function handleMetrics(req: Request): Response {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const authErr = metricsAuth.unauthorized(req.headers.get("authorization"));
  if (authErr) {
    return authErr;
  }

  const lines = [
    "# HELP tether_connected_nodes Number of currently connected daemons.",
    "# TYPE tether_connected_nodes gauge",
    `tether_connected_nodes ${connectedNodes}`,
    "",
    "# HELP tether_sse_connections_total SSE connections established.",
    "# TYPE tether_sse_connections_total counter",
    `tether_sse_connections_total ${sseConnectionsTotal}`,
    "",
    "# HELP tether_registration_writes_total Node registration upserts.",
    "# TYPE tether_registration_writes_total counter",
    `tether_registration_writes_total ${registrationWritesTotal}`,
    "",
    "# HELP tether_state_writes_total Installation state upserts.",
    "# TYPE tether_state_writes_total counter",
    `tether_state_writes_total ${stateWritesTotal}`,
    "",
    "# HELP tether_liveness_timeouts_total Nodes marked unavailable by timeout.",
    "# TYPE tether_liveness_timeouts_total counter",
    `tether_liveness_timeouts_total ${livenessTimeoutsTotal}`,
    "",
    "# HELP tether_desired_state_pushes_total Desired-state events pushed to daemons.",
    "# TYPE tether_desired_state_pushes_total counter",
    `tether_desired_state_pushes_total ${desiredStatePushesTotal}`,
  ];

  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
