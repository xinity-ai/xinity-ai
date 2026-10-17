import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "model-registry" });

type RegisteredInstallation = { id: string; specifier: string; port: number; driver: string };

const registry = new Map<string, RegisteredInstallation>();

export function updateRegistry(installations: RegisteredInstallation[]) {
  registry.clear();
  for (const inst of installations) {
    registry.set(inst.id, { id: inst.id, specifier: inst.specifier, port: inst.port, driver: inst.driver });
  }
  log.debug({ count: registry.size }, "Model registry updated");
}

export function resolveInstallation(id: string): RegisteredInstallation | undefined {
  return registry.get(id);
}

export function listInstallations(): RegisteredInstallation[] {
  return [...registry.values()];
}
