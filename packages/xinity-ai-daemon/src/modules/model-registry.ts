import type { ModelInstallation } from "common-db";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "model-registry" });

const registry = new Map<string, { port: number; driver: string }>();

/** Replace the entire registry with the current set of installations, keyed by canonical specifier. */
export function updateRegistry(installations: Pick<ModelInstallation, "specifier" | "port" | "driver">[]) {
  registry.clear();
  for (const inst of installations) {
    registry.set(inst.specifier, { port: inst.port, driver: inst.driver });
  }
  log.debug({ count: registry.size }, "Model registry updated");
}

/** Look up an installation's local backend port and driver by canonical specifier. */
export function resolveModel(specifier: string): { port: number; driver: string } | undefined {
  return registry.get(specifier);
}
