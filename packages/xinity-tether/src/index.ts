import "zod/compile";

import { logMigrationFailureFatal } from "common-db";
import { nodeRegistrationSchema, installationStateReportSchema, protocolFingerprint, getTlsConfig } from "common-env";
import { env } from "./env";
import { rootLogger } from "./logger";
import { checkMigrations, subscribe, end as endDB } from "./db";
import { verifyBearerToken, unauthorized } from "./auth";
import { addConnection, removeConnection, pushDesiredState, runKeepaliveLoop, sendShutdownToAll, isConnected, getConnectedNodeIds } from "./connections";
import { buildDesiredState } from "./desired-state";
import { createNotifyBus } from "./notify-bus";
import { writeRegistration, queueInstallationStates, flushAndStop } from "./status-writer";
import { handleMetrics, incRequestRejections } from "./metrics";
import { buildListenTarget } from "./serve-config";

const log = rootLogger;

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

const keepaliveTimer = runKeepaliveLoop(env.KEEPALIVE_INTERVAL_MS, env.LIVENESS_TIMEOUT_MS);

async function handleSSEStream(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    incRequestRejections("stream", "method_not_allowed");
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!verifyBearerToken(req)) {
    incRequestRejections("stream", "unauthorized");
    return unauthorized();
  }

  const body = await req.json().catch(() => null);
  const parsed = nodeRegistrationSchema.safeParse(body);
  if (!parsed.success) {
    incRequestRejections("stream", "invalid_payload");
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const { nodeId } = parsed.data;

  const expected = protocolFingerprint();
  if (parsed.data.protocolFingerprint !== expected) {
    incRequestRejections("stream", "protocol_mismatch");
    log.warn(
      { nodeId, expected, received: parsed.data.protocolFingerprint },
      "Protocol version mismatch",
    );
    return Response.json(
      { error: `Protocol version mismatch (tether: ${expected}, daemon: ${parsed.data.protocolFingerprint})` },
      { status: 409 },
    );
  }

  try {
    await writeRegistration(parsed.data);
  } catch (err) {
    incRequestRejections("stream", "registration_failed");
    log.error({ err, nodeId }, "Registration write failed during SSE handshake");
    return Response.json({ error: "Internal error" }, { status: 500 });
  }

  let connId: number | undefined;
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      connId = await addConnection(nodeId, controller);

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
    },
  });
}

async function handleStatus(req: Request): Promise<Response> {
  if (!verifyBearerToken(req)) {
    incRequestRejections("status", "unauthorized");
    return unauthorized();
  }

  const body = await req.json().catch(() => null);
  const parsed = installationStateReportSchema.safeParse(body);
  if (!parsed.success) {
    incRequestRejections("status", "invalid_payload");
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  queueInstallationStates(parsed.data);
  return Response.json({ ok: true });
}

const serveTarget = buildListenTarget(env);
const tls = getTlsConfig(env);

const server = Bun.serve({
  ...serveTarget,
  tls,
  routes: {
    "/health": () => Response.json({ ok: true }),
    "/metrics": handleMetrics,
    "/api/v1/stream": handleSSEStream,
    "/api/v1/status": handleStatus,
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
});

log.info({ ...serveTarget, tls: !!tls }, `Tether started (${tls ? "https" : "http"})`);

async function shutdown() {
  clearInterval(keepaliveTimer);
  sendShutdownToAll();
  await flushAndStop();
  await notifyBus.stop();
  await endDB();
  server.stop();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
