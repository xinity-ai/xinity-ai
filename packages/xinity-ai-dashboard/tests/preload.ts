import { mock } from "bun:test";
import { dashboardEnvSchema } from "../src/lib/server/env-schema";

mock.module("$app/environment", () => ({
  building: false,
  dev: false,
  browser: false,
}));

/**
 * Bun binds the first registration for a specifier, so cross-cutting mocks live
 * here. Per-file ones leave some suites mutating an object the code never sees.
 * Parsed from the real schema because logging.ts reads fields at import time.
 */
const serverEnv: Record<string, unknown> = dashboardEnvSchema.parse({
  DB_CONNECTION_URL: "postgresql://test:test@localhost:5432/test",
  NODE_ENV: "test",
  BETTER_AUTH_SECRET: "test-better-auth-secret",
  METRICS_AUTH: "test:test",
});

mock.module("$lib/server/serverenv", () => ({
  serverEnv,
  isInstanceAdmin: () => false,
}));

/** Only the barrel. license/license.test.ts exercises the deep path, which this leaves untouched. */
const licensedFeatures: string[] = [];

mock.module("$lib/server/license", () => ({
  hasFeature: (feature: string) => licensedFeatures.includes(feature),
  maxVramGb: () => Infinity,
  getLicenseSummary: () => ({ tier: "free", licensee: null, features: {} }),
  licensedFeatures,
}));
