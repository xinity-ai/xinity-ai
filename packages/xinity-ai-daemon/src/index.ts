import type { SubscriptionLike } from "rxjs";
import { dbSync, setDesiredInstallations } from "./modules/db-sync";
import { startMetricsSampler, type MetricsSampler } from "./modules/metrics-sampler";
import { startServer } from "./modules/serverfront/webserver";
import { buildRegistration } from "./modules/statekeeper";
import { connectSSE } from "./modules/tether-client";
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
  await startServer();
  const registration = await buildRegistration();
  metricsSampler = startMetricsSampler();
  const coordinator = dbSync();
  subscription = coordinator.start();

  const onFatal = (label: string) => (err: unknown) => {
    rootLogger.fatal({ err }, label);
    void shutdown().finally(() => process.exit(1));
  };
  process.once("uncaughtException", onFatal("Uncaught exception"));
  process.once("unhandledRejection", onFatal("Unhandled rejection"));

  for await (const state of connectSSE(registration)) {
    if (shuttingDown) {
      break;
    }
    setDesiredInstallations(state.installations);
    coordinator.signal("notification");
  }
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  await metricsSampler?.stop();
  subscription?.unsubscribe();
  process.exit(0);
}
