import { logMigrationFailureFatal } from "common-db";
import { nodeRegistrationSchema, installationStateReportSchema } from "common-env";
import { env } from "./env";
import { rootLogger } from "./logger";
import { checkMigrations } from "./db";
import { verifyBearerToken, unauthorized } from "./auth";
import { addConnection, removeConnection, pushDesiredState, runKeepaliveLoop, sendShutdownToAll } from "./connections";
import { buildDesiredState } from "./desired-state";
import { subscribe, unsubscribe, shutdown as shutdownNotifyBus } from "./notify-bus";
import { writeRegistration, writeInstallationStates } from "./status-writer";
import { handleMetrics } from "./metrics";

const log = rootLogger;

const migrationState = await checkMigrations();
if (migrationState.status !== "ok") {
  logMigrationFailureFatal(migrationState, rootLogger, "tether");
  process.exit(1);
}

const keepaliveTimer = runKeepaliveLoop(env.KEEPALIVE_INTERVAL_MS, env.LIVENESS_TIMEOUT_MS);

function handleSSEStream(req: Request): Response {
  if (!verifyBearerToken(req)) {
    return unauthorized();
  }

  const url = new URL(req.url);
  const nodeId = url.searchParams.get("nodeId");
  if (!nodeId) {
    return Response.json({ error: "nodeId query parameter required" }, { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      await addConnection(nodeId, controller);
      await subscribe(nodeId);

      try {
        const state = await buildDesiredState(nodeId);
        pushDesiredState(nodeId, state);
      } catch (err) {
        log.error({ err, nodeId }, "Failed to push initial desired state");
      }
    },
    async cancel() {
      await unsubscribe(nodeId);
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

async function handleRegister(req: Request): Promise<Response> {
  if (!verifyBearerToken(req)) {
    return unauthorized();
  }

  const body = await req.json().catch(() => null);
  const parsed = nodeRegistrationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    await writeRegistration(parsed.data);
    return Response.json({ ok: true });
  } catch (err) {
    log.error({ err }, "Registration write failed");
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
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

  try {
    await writeInstallationStates(parsed.data);
    return Response.json({ ok: true });
  } catch (err) {
    log.error({ err }, "Status write failed");
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

const serveTarget = env.UNIX_SOCKET
  ? { unix: env.UNIX_SOCKET }
  : { port: env.PORT, hostname: env.HOST };

const server = Bun.serve({
  ...serveTarget,
  routes: {
    "/health": () => Response.json({ ok: true }),
    "/metrics": handleMetrics,
    "/api/v1/stream": handleSSEStream,
    "/api/v1/register": handleRegister,
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
  await shutdownNotifyBus();
  server.stop();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
