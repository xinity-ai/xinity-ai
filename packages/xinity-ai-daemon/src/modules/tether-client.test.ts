import { test, expect, mock } from "bun:test";
import type { InstallationStateReport } from "common-env";

// Mock env to avoid parseEnv side-effect (requires DB_CONNECTION_URL etc. in CI).
// The trailing slash is the shape that produced `//api/v1/stream` in production.
mock.module("../env", () => ({
  env: { TETHER_URL: "http://100.64.0.11:2000/", TETHER_SECRET: "test", LOG_LEVEL: "silent" },
}));

const { reportInstallationStates } = await import("./tether-client");

test("tether endpoints ignore a trailing slash on TETHER_URL", async () => {
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    requested.push(String(input));
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;

  try {
    await reportInstallationStates({ nodeId: "node-1", states: [] } as InstallationStateReport);
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(requested).toEqual(["http://100.64.0.11:2000/api/v1/status"]);
});
