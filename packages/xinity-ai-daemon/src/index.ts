import { SubscriptionLike } from "rxjs";
import { dbSync } from "./modules/db-sync";
import { startMetricsSampler, type MetricsSampler } from "./modules/metrics-sampler";
import { startServer } from "./modules/serverfront/webserver";
import { getNodeId, setOffline, setOnline } from "./modules/statekeeper";
import { getDB, listen, checkMigrations } from "./db/connection";
import { sql, logMigrationFailureFatal } from "common-db";
import { rootLogger } from "./logger";

let shuttingDown = false;
let subscription: SubscriptionLike | undefined;
let metricsSampler: MetricsSampler | undefined;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void shutdown());
}

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
  metricsSampler = startMetricsSampler();
  const coordinator = dbSync();
  subscription = coordinator.start();

  const onFatal = (label: string) => (err: unknown) => {
    rootLogger.fatal({ err }, label);
    void shutdown().finally(() => process.exit(1));
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

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  // Wake the listen loop so it sees shuttingDown === true and breaks.
  try {
    const nodeId = await getNodeId();
    await getDB().execute(sql.raw(`NOTIFY "ai_node:${nodeId}"`));
  } catch {}

  // Stop before setOffline so no flush writes to ai_node after it is marked offline.
  await metricsSampler?.stop();

  try {
    await setOffline();
  } catch (err) {
    rootLogger.error({ err }, "Failed to set node offline during shutdown");
  }

  subscription?.unsubscribe();
  process.exit(0);
}
