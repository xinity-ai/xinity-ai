import { describe, test, expect } from "bun:test";
import { buildListenTarget } from "./serve-config";
import { tetherEnvSchema } from "./env-schema";

const baseEnv = { DB_CONNECTION_URL: "postgres://localhost/test", TETHER_SECRET: "test" };

describe("tether listen config", () => {
  test("the listen target carries IDLE_TIMEOUT, without which the server drops idle SSE streams", () => {
    const env = tetherEnvSchema.parse(baseEnv);
    expect(buildListenTarget(env)).toEqual({ port: 4020, hostname: "0.0.0.0", idleTimeout: 255 });
    expect(buildListenTarget({ ...env, UNIX_SOCKET: "/run/tether.sock" }))
      .toEqual({ unix: "/run/tether.sock", idleTimeout: undefined });
  });

  test("a keepalive too slow to hold a connection open is rejected at startup", () => {
    expect(() => tetherEnvSchema.parse({ ...baseEnv, IDLE_TIMEOUT: "20", KEEPALIVE_INTERVAL_MS: "15000" }))
      .toThrow(/KEEPALIVE_INTERVAL_MS/);
  });
});
