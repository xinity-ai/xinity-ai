import { describe, test, expect } from "bun:test";
import { resolveConfig } from "common-env";
import { buildListenTarget } from "./serve-config";
import { tetherConfig, type TetherConfig } from "./config-schema";

const baseEnv = { DB_CONNECTION_URL: "postgres://localhost/test", TETHER_SECRET: "test" };
const resolve = (env: Record<string, string>) =>
  resolveConfig<TetherConfig>(tetherConfig, { env }).value;

describe("tether listen config", () => {
  test("the listen target carries IDLE_TIMEOUT, without which the server drops idle SSE streams", () => {
    expect(buildListenTarget(resolve(baseEnv).server))
      .toEqual({ port: 4020, hostname: "0.0.0.0", idleTimeout: 255 });
    expect(buildListenTarget(resolve({ ...baseEnv, UNIX_SOCKET: "/run/tether.sock" }).server))
      .toEqual({ unix: "/run/tether.sock", idleTimeout: undefined });
  });

  test("a keepalive too slow to hold a connection open is rejected at startup", () => {
    expect(() => resolve({ ...baseEnv, IDLE_TIMEOUT: "20", KEEPALIVE_INTERVAL_MS: "15000" }))
      .toThrow(/KEEPALIVE_INTERVAL_MS/);
  });
});
