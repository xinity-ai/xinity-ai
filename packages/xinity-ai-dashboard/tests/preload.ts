import { mock } from "bun:test";
import { resolveConfig } from "common-env";
import { dashboardConfig, type DashboardConfig } from "../src/lib/server/config-schema";

mock.module("$app/environment", () => ({
  building: false,
  dev: false,
  browser: false,
}));

/** Mutable on purpose: suites that need a different value assign to it in a beforeEach. */
const config: DashboardConfig = resolveConfig<DashboardConfig>(dashboardConfig, {
  env: {
    DB_CONNECTION_URL: "postgresql://test:test@localhost:5432/test",
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    METRICS_AUTH: "test:test",
    MULTI_TENANT_MODE: "true",
  },
}).value;

mock.module("$lib/server/config", () => ({ config }));

/** Only the barrel. license/license.test.ts exercises the deep path, which this leaves untouched. */
const licensedFeatures: string[] = [];

mock.module("$lib/server/license", () => ({
  hasFeature: (feature: string) => licensedFeatures.includes(feature),
  maxVramGb: () => Infinity,
  getLicenseSummary: () => ({ tier: "free", licensee: null, features: {} }),
  licensedFeatures,
}));

mock.module("$lib/server/logging", () => ({
  rootLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

/**
 * Importing the real module opens a connection pool, so the double lives here.
 * Suites that need rows assign `dbHandle.getDB` and call `dbHandle.reset` when
 * done, which keeps one file's stub from standing in for another's.
 */
const rejectDBUse = () => {
  throw new Error("no database under the test preload: assign dbHandle.getDB in the suite that needs one");
};

const dbHandle: { getDB: () => unknown; reset: () => void } = {
  getDB: rejectDBUse,
  reset: () => {
    dbHandle.getDB = rejectDBUse;
  },
};

mock.module("$lib/server/db", () => ({
  getDB: () => dbHandle.getDB(),
  dbHandle,
}));
