import type { ModelInstallation } from "common-db";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "model-registry" });

const registry = new Map<string, { port: number; driver: string }>();

/** Replace the entire registry with the current set of installations. */
export function updateRegistry(installations: Pick<ModelInstallation, "model" | "port" | "driver">[]) {
  registry.clear();
  for (const inst of installations) {
    registry.set(inst.model, { port: inst.port, driver: inst.driver });
  }
  log.debug({ count: registry.size }, "Model registry updated");
}

/** Look up a model's local backend port and driver. */
export function resolveModel(model: string): { port: number; driver: string } | undefined {
  return registry.get(model);
}
