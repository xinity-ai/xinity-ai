import "zod/compile";

import type { SubscriptionLike } from "rxjs";
import { activationRefusal, createSecretUnsealer, type InterconnectPort } from "common-env";

import { dbSync, setDesiredInstallations } from "./modules/db-sync";
import { startMetricsSampler, type MetricsSampler } from "./modules/metrics-sampler";
import { startServer } from "./modules/serverfront/webserver";
import { buildRegistration, checkInterconnect } from "./modules/statekeeper";
import { connectSSE, reportInterconnect } from "./modules/tether-client";
import { tetherConfigFeed } from "./modules/config-feed";
import { config, configStore } from "./config";
import { rootLogger } from "./logger";
import { daemonConfig } from "./config-schema";

let shuttingDown = false;
let subscription: SubscriptionLike | undefined;
let metricsSampler: MetricsSampler | undefined;
const INTERCONNECT_CHECK_MS = 30_000;
let interconnectTimer: Timer | undefined;
let reportedInterconnect: InterconnectPort[] = [];
const tetherStream = new AbortController();

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
  const refusal = activationRefusal(daemonConfig, rootLogger);
  if (refusal) {
    rootLogger.fatal(refusal);
    process.exit(1);
  }

  await startServer();
  const registration = await buildRegistration();
  reportedInterconnect = registration.interconnect;
  interconnectTimer = setInterval(() => void reportInterconnectChange(registration.nodeId), INTERCONNECT_CHECK_MS);
  metricsSampler = startMetricsSampler();
  const coordinator = dbSync();
  subscription = coordinator.start();

  const onFatal = (label: string) => (err: unknown) => {
    rootLogger.fatal({ err }, label);
    void shutdown(1).finally(() => process.exit(1));
  };
  process.once("uncaughtException", onFatal("Uncaught exception"));
  process.once("unhandledRejection", onFatal("Unhandled rejection"));

  await configStore.start(tetherConfigFeed, {
    unseal: createSecretUnsealer({ current: config.secretKey, previous: config.previousSecretKey }, rootLogger),
  });

  for await (const state of connectSSE(async () => ({ ...registration, interconnect: reportedInterconnect }), tetherStream.signal)) {
    if (shuttingDown) {
      break;
    }
    setDesiredInstallations(state.installations);
    coordinator.signal("notification");
  }

  await shutdown(1);
}

async function reportInterconnectChange(nodeId: string): Promise<void> {
  const interconnect = await checkInterconnect();
  if (Bun.deepEquals(interconnect, reportedInterconnect)) {
    return;
  }
  if (await reportInterconnect({ nodeId, interconnect })) {
    reportedInterconnect = interconnect;
  }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  clearInterval(interconnectTimer);
  tetherStream.abort();
  await metricsSampler?.stop();
  await configStore.stop();
  subscription?.unsubscribe();
  process.exit(exitCode);
}
