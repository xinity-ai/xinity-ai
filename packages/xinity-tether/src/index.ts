import "zod/compile";

import { z } from "zod";
import { DYNAMIC_CONFIG_CHANNEL, logMigrationFailureFatal, readDynamicConfig, sql } from "common-db";
import { nodeRegistrationSchema, installationStateReportSchema, interconnectReportSchema, heartbeatReportSchema, protocolFingerprint, activationRefusal, createDbConfigFeed, canonicalRegistration, canonicalStateReport, canonicalInterconnectReport, canonicalHeartbeatReport, verifyNodeSignature, STREAM_PATH, STATUS_PATH, INTERCONNECT_PATH, HEARTBEAT_PATH, KEEPALIVE_INTERVAL_HEADER, createDependencyProbe, createHealthHandler, parseMetricsAuth, probeOwnHealth, type TetherRefusal, type TetherRefusalReason, type VerifyFailure } from "common-env";
import { tetherConfig } from "./config-schema";
import { config, configStore } from "./config";
import { rootLogger } from "./logger";
import { checkMigrations, getDB, subscribe, end as endDB } from "./db";
import { verifySignature, unauthorizedDetail } from "./auth";
import { addConnection, removeConnection, pushDesiredState, pushConfig, pushConfigToAll, runKeepaliveLoop, sendShutdownToAll, dropAllConnections, isConnected, getConnectedNodeIds, connectedPublicKey, markSeen } from "./connections";
import { createConfigBroadcast } from "./config-broadcast";
import { buildDesiredState, nodesOfGroupsOf } from "./desired-state";
import { createNotifyBus } from "./notify-bus";
import { writeRegistration, writeInterconnect, queueInstallationStates, flushAndStop, readPinnedPublicKey, partitionOwnedStates, onGroupStagesChanged } from "./status-writer";
import { handleMetrics, httpMetrics, incRequestRejections, type DaemonEndpoint } from "./metrics";
import { buildListenTarget } from "./serve-config";

const log = rootLogger;

const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
const handshakeSchema = z.object({ protocolFingerprint: z.string() });

function refuse(endpoint: DaemonEndpoint, reason: TetherRefusalReason, error: string, status: number): Response {
  incRequestRejections(endpoint, reason);
  return Response.json({ error, reason } satisfies TetherRefusal, { status });
}

// A skewed clock gets its own category, so a fleet drifting out of the window is not read as
// a fleet configured with the wrong secret.
const REJECTION_BY_FAILURE: Partial<Record<VerifyFailure, TetherRefusalReason>> = {
  stale: "unauthorized_stale",
  replayed: "unauthorized_replayed",
};

function rejectUnsigned(endpoint: DaemonEndpoint, reason: VerifyFailure): Response {
  return refuse(endpoint, REJECTION_BY_FAILURE[reason] ?? "unauthorized", unauthorizedDetail(reason), 401);
}

// The container healthcheck: the image ships no curl, so the binary asks the running instance itself.
if (Bun.argv.includes("--health")) {
  process.exit(await probeOwnHealth({ ...config.server, tls: !!config.tls }) ? 0 : 1);
}

const refusal = activationRefusal(tetherConfig, rootLogger);
if (refusal) {
  rootLogger.fatal(refusal);
  process.exit(1);
}

const migrationState = await checkMigrations();
if (migrationState.status !== "ok") {
  logMigrationFailureFatal(migrationState, rootLogger, "tether");
  process.exit(1);
}

const notifyBus = createNotifyBus({
  subscribe,
  buildDesiredState,
  pushDesiredState,
  isConnected,
  getConnectedNodeIds,
});

onGroupStagesChanged((states) =>
  nodesOfGroupsOf(states.map((state) => state.installationId)).then(
    (nodeIds) => nodeIds.forEach(notifyBus.queue),
    (err) => rootLogger.error({ err }, "Failed to tell a group's members about a member's stage"),
  ));

// Without the subscription a daemon would connect and then never hear about a
// deployment again, which is worse than refusing to serve at all.
try {
  await notifyBus.start();
} catch (err) {
  rootLogger.fatal({ err }, "Failed to subscribe to installation changes");
  process.exit(1);
}

// Every delegated setting already holds its configured fallback, so a failed subscription
// costs dashboard control of them, not a working tether.
// No unsealer: the tether delegates nothing secret and relays what it reads still sealed, so it
// is the one service in the path that never holds the key.
try {
  await configStore.start(createDbConfigFeed({
    channel: DYNAMIC_CONFIG_CHANNEL,
    read: () => readDynamicConfig(getDB()),
    subscribe,
    log: rootLogger,
  }));
} catch (err) {
  rootLogger.error({ err }, "Dynamic configuration unavailable, keeping the values this process booted with");
}

const configBroadcast = createConfigBroadcast({
  channel: DYNAMIC_CONFIG_CHANNEL,
  read: () => readDynamicConfig(getDB()),
  subscribe,
  pushToAll: pushConfigToAll,
  pushTo: pushConfig,
  log: rootLogger,
});

try {
  await configBroadcast.start();
} catch (err) {
  rootLogger.error({ err }, "Daemons will not receive dynamic configuration changes");
}

const databaseProbe = createDependencyProbe({
  name: "Database",
  ping: () => getDB().execute(sql`SELECT 1`),
  log,
  onUnreachable: () => {
    log.warn("Dropping all daemon connections until the database is reachable");
    dropAllConnections("db_unreachable");
  },
});

let keepaliveTimer: Timer | undefined;
configStore.watch(
  (value) => value.server.keepaliveIntervalMs(),
  (intervalMs) => {
    clearInterval(keepaliveTimer);
    keepaliveTimer = runKeepaliveLoop(intervalMs, config.server.livenessTimeoutMs);
    databaseProbe.start(intervalMs);
  },
);

async function handleSSEStream(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return refuse("stream", "method_not_allowed", "Method Not Allowed", 405);
  }

  const refused = verifySignature(req, STREAM_PATH);
  if (refused) {
    return rejectUnsigned("stream", refused);
  }

  const body = await req.json().catch(() => null);

  // Before the full schema, so a daemon whose payload shape predates this build is told its
  // protocol is incompatible rather than that some field it never heard of is missing.
  const handshake = handshakeSchema.safeParse(body);
  const expected = protocolFingerprint();
  if (!handshake.success || handshake.data.protocolFingerprint !== expected) {
    const received = handshake.success ? handshake.data.protocolFingerprint : "unknown";
    log.warn({ expected, received }, "Protocol version mismatch");
    return refuse("stream", "protocol_mismatch", `Protocol version mismatch (tether: ${expected}, daemon: ${received})`, 409);
  }

  const parsed = nodeRegistrationSchema.safeParse(body);
  if (!parsed.success) {
    return refuse("stream", "invalid_payload", parsed.error.message, 400);
  }

  const { nodeId, publicKey, signature } = parsed.data;

  if (!verifyNodeSignature(publicKey, canonicalRegistration(parsed.data, req.headers.get("authorization") ?? ""), signature)) {
    log.warn({ nodeId }, "Registration signature does not match the key it presents");
    return refuse("stream", "invalid_signature", "Registration signature is invalid", 401);
  }

  try {
    if (await writeRegistration(parsed.data) === "identity_mismatch") {
      return refuse("stream", "identity_mismatch", "This node id is registered to a different key", 403);
    }
  } catch (err) {
    log.error({ err, nodeId }, "Registration write failed during SSE handshake");
    return refuse("stream", "registration_failed", "Tether cannot write to its database", 503);
  }

  let connId: number | undefined;
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      connId = await addConnection(nodeId, controller, publicKey);

      if (cancelled) {
        await removeConnection(nodeId, "cancel", connId);
        return;
      }

      try {
        const state = await buildDesiredState(nodeId);
        pushDesiredState(nodeId, state);
      } catch (err) {
        log.error({ err, nodeId }, "Failed to push initial desired state");
      }

      configBroadcast.sendCurrent(nodeId);
    },
    async cancel() {
      cancelled = true;
      await removeConnection(nodeId, "cancel", connId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      [KEEPALIVE_INTERVAL_HEADER]: String(config.server.keepaliveIntervalMs()),
    },
  });
}

type SignedReport = { nodeId: string; signature: string };

async function verifiedReport<T extends SignedReport>(
  req: Request,
  endpoint: Exclude<DaemonEndpoint, "stream">,
  path: string,
  schema: z.ZodType<T>,
  canonical: (report: T, authorization: string) => string,
): Promise<{ report: T } | { refusal: Response }> {
  const refused = verifySignature(req, path);
  if (refused) {
    return { refusal: rejectUnsigned(endpoint, refused) };
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return { refusal: refuse(endpoint, "invalid_payload", parsed.error.message, 400) };
  }
  const { nodeId, signature } = parsed.data;
  const publicKey = connectedPublicKey(nodeId) ?? await readPinnedPublicKey(nodeId);
  if (!publicKey || !verifyNodeSignature(publicKey, canonical(parsed.data, req.headers.get("authorization") ?? ""), signature)) {
    log.warn({ nodeId, pinned: !!publicKey, endpoint }, "Report is not signed by this node");
    return { refusal: refuse(endpoint, "invalid_signature", "Report signature is invalid", 401) };
  }
  markSeen(nodeId);
  return { report: parsed.data };
}

async function handleStatus(req: Request): Promise<Response> {
  const verified = await verifiedReport(req, "status", STATUS_PATH, installationStateReportSchema, canonicalStateReport);
  if ("refusal" in verified) {
    return verified.refusal;
  }
  const { nodeId, states } = verified.report;

  const { owned, foreign } = await partitionOwnedStates(nodeId, states);
  if (foreign.length > 0) {
    log.error(
      { nodeId, installationIds: foreign.map((s) => s.installationId) },
      "Status report refused, it covers installations belonging to another node",
    );
    return refuse("status", "installation_not_owned", "Report covers installations owned by another node", 403);
  }

  queueInstallationStates(owned);
  return Response.json({ ok: true });
}

async function handleInterconnect(req: Request): Promise<Response> {
  const verified = await verifiedReport(req, "interconnect", INTERCONNECT_PATH, interconnectReportSchema, canonicalInterconnectReport);
  if ("refusal" in verified) {
    return verified.refusal;
  }
  const { nodeId, interconnect } = verified.report;

  await writeInterconnect(nodeId, interconnect);
  return Response.json({ ok: true });
}

async function handleHeartbeat(req: Request): Promise<Response> {
  const verified = await verifiedReport(req, "heartbeat", HEARTBEAT_PATH, heartbeatReportSchema, canonicalHeartbeatReport);
  return "refusal" in verified ? verified.refusal : Response.json({ ok: true });
}

const serveTarget = buildListenTarget(config.server);
const tls = config.tls && { cert: config.tls.cert, key: config.tls.key };

const server = Bun.serve({
  ...serveTarget,
  tls,
  routes: {
    "/health": httpMetrics.route("/health", createHealthHandler({
      readiness: { database: databaseProbe.check },
      credentials: parseMetricsAuth(config.metrics.auth),
    })),
    "/metrics": handleMetrics,
    "/api/v1/stream": httpMetrics.route("/api/v1/stream", handleSSEStream),
    "/api/v1/status": httpMetrics.route("/api/v1/status", handleStatus),
    "/api/v1/interconnect": httpMetrics.route("/api/v1/interconnect", handleInterconnect),
    "/api/v1/heartbeat": httpMetrics.route("/api/v1/heartbeat", handleHeartbeat),
  },
  fetch: httpMetrics.route("<unmatched>", () => new Response("Not Found", { status: 404 })),
});

log.info({ ...serveTarget, tls: !!tls }, `Tether started (${tls ? "https" : "http"})`);

async function shutdown() {
  const requestsDrained = server.stop();
  clearInterval(keepaliveTimer);
  databaseProbe.stop();
  await configStore.stop();
  await configBroadcast.stop();
  sendShutdownToAll();
  // A stream that finishes registering after the shutdown events stays open, so the wait is capped.
  await Promise.race([requestsDrained, Bun.sleep(SHUTDOWN_DRAIN_TIMEOUT_MS)]);
  await flushAndStop();
  await notifyBus.stop();
  await endDB();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
