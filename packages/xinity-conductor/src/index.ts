import { env } from "./env";
import { rootLogger } from "./logger";
import { checkMigrations } from "./db";
import { handleProbe } from "./routes/probe";
import { handleStatus } from "./routes/status";

process.on("unhandledRejection", (reason) => {
  rootLogger.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  rootLogger.error({ err }, "Uncaught exception");
});

const migrationState = await checkMigrations();
if (migrationState.status !== "ok") {
  rootLogger.fatal("Database migrations are not up to date, conductor cannot start.");
  if (migrationState.status === "pending") {
    rootLogger.fatal(`${migrationState.applied} of ${migrationState.expected} migrations applied, ${migrationState.expected - migrationState.applied} pending.`);
  } else if (migrationState.status === "no_table") {
    rootLogger.fatal("Migrations table not found, database not initialized.");
  } else {
    rootLogger.fatal(migrationState.message);
  }
  rootLogger.fatal('Run "xinity up db" or "cd packages/common-db && bun run migrate" to apply migrations.');
  process.exit(1);
}

const serveOptions = {
  routes: {
    "/health": () => Response.json({ ok: true }),
    "/probe": handleProbe,
    "/status": { POST: handleStatus },
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
} as const;

if (env.UNIX_SOCKET) {
  Bun.serve({ ...serveOptions, unix: env.UNIX_SOCKET });
  rootLogger.info({ unix: env.UNIX_SOCKET }, "Conductor started");
} else {
  Bun.serve({ ...serveOptions, hostname: env.HOST, port: env.PORT });
  rootLogger.info({ host: env.HOST, port: env.PORT }, "Conductor started");
}
