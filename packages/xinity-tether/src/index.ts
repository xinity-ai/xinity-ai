import { logMigrationFailureFatal } from "common-db";
import { nodeRegistrationSchema, installationStateReportSchema, protocolFingerprint } from "common-env";
import { env } from "./env";
import { rootLogger } from "./logger";
import { checkMigrations } from "./db";
import { verifyBearerToken, unauthorized } from "./auth";
import { addConnection, removeConnection, pushDesiredState, runKeepaliveLoop, sendShutdownToAll } from "./connections";
import { buildDesiredState } from "./desired-state";
import { subscribe, unsubscribe, shutdown as shutdownNotifyBus } from "./notify-bus";
import { writeRegistration, queueInstallationStates, flushAndStop } from "./status-writer";
import { handleMetrics } from "./metrics";
import { buildListenTarget } from "./serve-config";

const log = rootLogger;

const migrationState = await checkMigrations();
if (migrationState.status !== "ok") {
  logMigrationFailureFatal(migrationState, rootLogger, "tether");
  process.exit(1);
}

const keepaliveTimer = runKeepaliveLoop(env.KEEPALIVE_INTERVAL_MS, env.LIVENESS_TIMEOUT_MS);

async function handleSSEStream(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!verifyBearerToken(req)) {
    return unauthorized();
  }

  const body = await req.json().catch(() => null);
  const parsed = nodeRegistrationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const { nodeId } = parsed.data;

  const expected = protocolFingerprint();
  if (parsed.data.protocolFingerprint !== expected) {
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
    log.error({ err, nodeId }, "Registration write failed during SSE handshake");
    return Response.json({ error: "Internal error" }, { status: 500 });
  }

  let cancelled = false;
  let subscribed = false;

  const stream = new ReadableStream({
    async start(controller) {
      await addConnection(nodeId, controller);
      await subscribe(nodeId);
      subscribed = true;

      if (cancelled) {
        await unsubscribe(nodeId);
        await removeConnection(nodeId);
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
      if (subscribed) {
        await unsubscribe(nodeId);
      }
      await removeConnection(nodeId);
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
    return unauthorized();
  }

  const body = await req.json().catch(() => null);
  const parsed = installationStateReportSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  queueInstallationStates(parsed.data);
  return Response.json({ ok: true });
}

const serveTarget = buildListenTarget(env);

const server = Bun.serve({
  ...serveTarget,
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

log.info({ ...serveTarget }, "Tether started");

async function shutdown() {
  clearInterval(keepaliveTimer);
  sendShutdownToAll();
  await flushAndStop();
  await shutdownNotifyBus();
  server.stop();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
