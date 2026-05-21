import { SubscriptionLike } from "rxjs";
import { dbSync } from "./modules/db-sync";
import { startServer } from "./modules/serverfront/webserver";
import { getNodeId, setOffline, setOnline } from "./modules/statekeeper";
import { getDB, listen, checkMigrations } from "./db/connection";
import { sql, logMigrationFailureFatal } from "common-db";
import { rootLogger } from "./logger";

let shuttingDown = false;

if (import.meta.main) {
  main().catch((err) => {
    rootLogger.fatal({ err }, "Daemon failed to start");
    process.exit(1);
  });
}

async function main() {
  const migrationState = await checkMigrations();
  if (migrationState.status !== "ok") {
    logMigrationFailureFatal(migrationState, rootLogger, "daemon");
    process.exit(1);
  }

  await startServer();
  await setOnline();
  const coordinator = dbSync();
  const subscription = coordinator.start();

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => shutdown(subscription));
  }

  const onFatal = (label: string) => (err: unknown) => {
    rootLogger.fatal({ err }, label);
    void shutdown(subscription).finally(() => process.exit(1));
  };
  process.once("uncaughtException", onFatal("Uncaught exception"));
  process.once("unhandledRejection", onFatal("Unhandled rejection"));

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

