import "zod/compile";

import { z } from "zod";
import { DYNAMIC_CONFIG_CHANNEL, logMigrationFailureFatal, readDynamicConfig } from "common-db";
import { nodeRegistrationSchema, installationStateReportSchema, protocolFingerprint, activationRefusal, createDbConfigFeed, canonicalRegistration, canonicalStateReport, verifyNodeSignature, STREAM_PATH, STATUS_PATH, KEEPALIVE_INTERVAL_HEADER, type VerifyFailure } from "common-env";
import { tetherConfig } from "./config-schema";
import { config, configStore } from "./config";
import { rootLogger } from "./logger";
import { checkMigrations, getDB, subscribe, end as endDB } from "./db";
import { verifySignature, unauthorized } from "./auth";
import { addConnection, removeConnection, pushDesiredState, pushConfig, pushConfigToAll, runKeepaliveLoop, sendShutdownToAll, isConnected, getConnectedNodeIds, connectedPublicKey } from "./connections";
import { createConfigBroadcast } from "./config-broadcast";
import { buildDesiredState } from "./desired-state";
import { createNotifyBus } from "./notify-bus";
import { writeRegistration, queueInstallationStates, flushAndStop, readPinnedPublicKey, partitionOwnedStates } from "./status-writer";
import { handleMetrics, httpMetrics, incRequestRejections } from "./metrics";
import { buildListenTarget } from "./serve-config";

const log = rootLogger;

const handshakeSchema = z.object({ protocolFingerprint: z.string() });

// A skewed clock gets its own series, so a fleet drifting out of the window is not read as
// a fleet configured with the wrong secret.
function rejectUnsigned(endpoint: "stream" | "status", reason: VerifyFailure): Response {
  incRequestRejections(endpoint, reason === "stale" ? "unauthorized_stale" : "unauthorized");
  return unauthorized(reason);
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

let keepaliveTimer: Timer | undefined;
configStore.watch(
  (value) => value.server.keepaliveIntervalMs(),
  (intervalMs) => {
    clearInterval(keepaliveTimer);
    keepaliveTimer = runKeepaliveLoop(intervalMs, config.server.livenessTimeoutMs);
  },
);

async function handleSSEStream(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    incRequestRejections("stream", "method_not_allowed");
    return new Response("Method Not Allowed", { status: 405 });
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
    incRequestRejections("stream", "protocol_mismatch");
    log.warn({ expected, received }, "Protocol version mismatch");
    return Response.json(
      { error: `Protocol version mismatch (tether: ${expected}, daemon: ${received})` },
      { status: 409 },
    );
  }

  const parsed = nodeRegistrationSchema.safeParse(body);
  if (!parsed.success) {
    incRequestRejections("stream", "invalid_payload");
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const { nodeId, publicKey, signature } = parsed.data;

  if (!verifyNodeSignature(publicKey, canonicalRegistration(parsed.data), signature)) {
    incRequestRejections("stream", "identity_mismatch");
    log.warn({ nodeId }, "Registration signature does not match the key it presents");
    return Response.json({ error: "Registration signature is invalid" }, { status: 401 });
  }

  try {
    if (await writeRegistration(parsed.data) === "identity_mismatch") {
      incRequestRejections("stream", "identity_mismatch");
      return Response.json({ error: "This node id is registered to a different key" }, { status: 403 });
    }
  } catch (err) {
    incRequestRejections("stream", "registration_failed");
    log.error({ err, nodeId }, "Registration write failed during SSE handshake");
    return Response.json({ error: "Internal error" }, { status: 500 });
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

async function handleStatus(req: Request): Promise<Response> {
  const refused = verifySignature(req, STATUS_PATH);
  if (refused) {
    return rejectUnsigned("status", refused);
  }

  const parsed = installationStateReportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    incRequestRejections("status", "invalid_payload");
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const { nodeId, states, signature } = parsed.data;

  const publicKey = connectedPublicKey(nodeId) ?? await readPinnedPublicKey(nodeId);
  if (!publicKey || !verifyNodeSignature(publicKey, canonicalStateReport(parsed.data), signature)) {
    incRequestRejections("status", "identity_mismatch");
    log.warn({ nodeId, pinned: !!publicKey }, "Status report is not signed by this node");
    return Response.json({ error: "Report signature is invalid" }, { status: 401 });
  }

  const { owned, foreign } = await partitionOwnedStates(nodeId, states);
  if (foreign.length > 0) {
    incRequestRejections("status", "installation_not_owned");
    log.error(
      { nodeId, installationIds: foreign.map((s) => s.installationId) },
      "Status report refused, it covers installations belonging to another node",
    );
    return Response.json({ error: "Report covers installations owned by another node" }, { status: 403 });
  }

  queueInstallationStates(owned);
  return Response.json({ ok: true });
}

const serveTarget = buildListenTarget(config.server);
const tls = config.tls && { cert: config.tls.cert, key: config.tls.key };

const server = Bun.serve({
  ...serveTarget,
  tls,
  routes: {
    "/health": httpMetrics.route("/health", () => Response.json({ ok: true })),
    "/metrics": handleMetrics,
    "/api/v1/stream": httpMetrics.route("/api/v1/stream", handleSSEStream),
    "/api/v1/status": httpMetrics.route("/api/v1/status", handleStatus),
  },
  fetch: httpMetrics.route("<unmatched>", () => new Response("Not Found", { status: 404 })),
});

log.info({ ...serveTarget, tls: !!tls }, `Tether started (${tls ? "https" : "http"})`);

async function shutdown() {
  clearInterval(keepaliveTimer);
  await configStore.stop();
  await configBroadcast.stop();
  sendShutdownToAll();
  await flushAndStop();
  await notifyBus.stop();
  await endDB();
  server.stop();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
