import { resolveConfig } from "common-env";
import { daemonConfig, type DaemonConfig } from "./config-schema";

const TEST_ENV = {
  TETHER_URL: "http://localhost:4020",
  TETHER_SECRET: "test",
  INFOSERVER_URL: "http://localhost:19090",
  LOG_LEVEL: "fatal",
};

// Derived from the declaration, so a field added there cannot go missing here and surface as an
// undefined deep inside an unrelated test.
export function mockDaemonConfig(overrides: Record<string, string> = {}): DaemonConfig {
  return resolveConfig<DaemonConfig>(daemonConfig, { env: { ...TEST_ENV, ...overrides } }).value;
}

// mock.module replaces the module for every file in the run, so an omitted export breaks
// whichever module statically imports it.
export function mockConfigModule(overrides: Record<string, string> = {}) {
  return { config: mockDaemonConfig(overrides), configStore: { delegatedKeys: [] } };
}
