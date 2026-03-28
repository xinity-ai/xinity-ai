import { SubscriptionLike } from "rxjs";
import { dbSync } from "./modules/db-sync";
import { startServer } from "./modules/serverfront/webserver";
import { getNodeId, setOffline, setOnline } from "./modules/statekeeper";
import { getDB, listen, checkMigrations } from "./db/connection";
import { sql } from "common-db";
import { rootLogger } from "./logger";

let shuttingDown = false;

if (import.meta.main) {
  main();
}

async function main() {
  const migrationState = await checkMigrations();
  if (migrationState.status !== "ok") {
    rootLogger.fatal("Database migrations are not up to date, daemon cannot start.");
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

  await startServer();
  await setOnline();
  const coordinator = dbSync();
  const subscription = coordinator.start();
  process.once("SIGTERM", () => shutdown(subscription));
  process.once("SIGINT", () => shutdown(subscription));
  process.once("uncaughtException", (err) => {
    rootLogger.fatal({ err }, "Uncaught exception");
    void shutdown(subscription);
  });
  process.once("unhandledRejection", (err) => {
    rootLogger.fatal({ err }, "Unhandled rejection");
    void shutdown(subscription);
  });

  const nodeId = await getNodeId();
  for await (const _notification of listen(`ai_node:${nodeId}`)) {
    if (shuttingDown) break;
    rootLogger.debug("Responding to DB notification");
    coordinator.signal("notification");
  }
}

async function shutdown(subscription: SubscriptionLike) {
  if (shuttingDown) return;
  shuttingDown = true;

  // Wake the listen loop so it can break out and release the connection.
  try {
    const nodeId = await getNodeId();
    await getDB().execute(sql.raw(`NOTIFY "ai_node:${nodeId}"`));
  } catch {
    // best-effort
  }

  try {
    await setOffline();
  } catch (err) {
    rootLogger.error({ err }, "Failed to set node offline during shutdown");
  }

  subscription.unsubscribe();
  process.exit(0);
}

