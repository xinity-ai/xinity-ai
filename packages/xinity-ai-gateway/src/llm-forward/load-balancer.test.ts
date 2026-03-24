import { describe, test, expect, beforeEach, spyOn, afterEach, mock } from "bun:test";
import { redis } from "bun";

mock.module("../env", () => ({
  env: {
    HOST: "localhost",
    PORT: 4010,
    DB_CONNECTION_URL: "postgresql://localhost/test",
    REDIS_URL: "redis://localhost:6379",
    WEB_SEARCH_ENGINE_URL: undefined,
    RESPONSE_CACHE_TTL_SECONDS: 3600,
    INFOSERVER_URL: "http://localhost:3000",
    INFOSERVER_CACHE_TTL_MS: 30000,
    LOAD_BALANCE_STRATEGY: "random",
    BACKEND_TIMEOUT_MS: 300000,
    LOG_LEVEL: "info",
    LOG_DIR: undefined,
    METRICS_AUTH: undefined,
  },
}));

import type { SelectHostInput } from "./load-balancer";
const { selectHost } = await import("./load-balancer");

let mockRedisSend: ReturnType<typeof spyOn>;

function makeInput(overrides?: Partial<SelectHostInput>): SelectHostInput {
  return {
    hosts: ["host-a:8080", "host-b:8080"],
    earlyHosts: ["host-c:8080"],
    canaryProgress: 100,
    hasEarlyModel: false,
    keyId: "key-1",
    publicModel: "my-model",
    ...overrides,
  };
}

beforeEach(() => {
  mockRedisSend = spyOn(redis, "send").mockImplementation(
    ((cmd: string, _args: string[]) => {
      if (cmd === "GETEX") return Promise.resolve(null);
      if (cmd === "INCR") return Promise.resolve(1);
      if (cmd === "MGET") return Promise.resolve(["0", "0"]);
      if (cmd === "SET") return Promise.resolve("OK");
      if (cmd === "EVAL") return Promise.resolve(1);
      if (cmd === "DECR") return Promise.resolve(0);
      return Promise.resolve(null);
    }) as any,
  );
});

afterEach(() => {
  mockRedisSend.mockRestore();
});

describe("selectHost", () => {
  test("empty pool returns undefined", async () => {
    const result = await selectHost("random", makeInput({ hosts: [], canaryProgress: 100 }));
    expect(result).toBeUndefined();
  });

  test("single host returns it directly", async () => {
    const input = makeInput({ hosts: ["only-host:8080"] });

    for (const strategy of ["random", "round-robin", "least-connections"] as const) {
      const result = await selectHost(strategy, input);
      expect(result).toBeDefined();
      expect(result!.host).toBe("only-host:8080");
      expect(result!.useFinalModel).toBe(true);
    }
  });

  test("session affinity hit returns cached host", async () => {
    mockRedisSend.mockImplementation(
      ((cmd: string, _args: string[]) => {
        if (cmd === "GETEX") {
          return Promise.resolve(
            JSON.stringify({ host: "host-a:8080", useFinalModel: true }),
          );
        }
        if (cmd === "SET") return Promise.resolve("OK");
        if (cmd === "EVAL") return Promise.resolve(1);
        if (cmd === "DECR") return Promise.resolve(0);
        return Promise.resolve(null);
      }) as any,
    );

    const result = await selectHost("random", makeInput());
    expect(result).toBeDefined();
    expect(result!.host).toBe("host-a:8080");
    expect(result!.useFinalModel).toBe(true);
  });

  test("session affinity miss when cached host is gone from pool", async () => {
    mockRedisSend.mockImplementation(
      ((cmd: string, _args: string[]) => {
        if (cmd === "GETEX") {
          return Promise.resolve(
            JSON.stringify({ host: "host-gone:8080", useFinalModel: true }),
          );
        }
        if (cmd === "INCR") return Promise.resolve(0);
        if (cmd === "SET") return Promise.resolve("OK");
        if (cmd === "EVAL") return Promise.resolve(1);
        if (cmd === "DECR") return Promise.resolve(0);
        if (cmd === "MGET") return Promise.resolve(["0", "0"]);
        return Promise.resolve(null);
      }) as any,
    );

    const result = await selectHost("random", makeInput());
    expect(result).toBeDefined();
    expect(["host-a:8080", "host-b:8080"]).toContain(result!.host);
  });

  test("canary routing to final model when canaryProgress=100", async () => {
    const result = await selectHost(
      "random",
      makeInput({ canaryProgress: 100, hasEarlyModel: true }),
    );
    expect(result).toBeDefined();
    expect(result!.useFinalModel).toBe(true);
    expect(["host-a:8080", "host-b:8080"]).toContain(result!.host);
  });

  test("canary routing to early model when canaryProgress=0", async () => {
    // Math.random() * 100 is always >= 0, so with canaryProgress=0
    // the condition Math.random() * 100 < 0 is always false.
    // Combined with hasEarlyModel=true: useFinalModel = !true || false = false
    const mathRandomSpy = spyOn(Math, "random").mockReturnValue(0.5);

    const result = await selectHost(
      "random",
      makeInput({ canaryProgress: 0, hasEarlyModel: true }),
    );
    expect(result).toBeDefined();
    expect(result!.useFinalModel).toBe(false);
    expect(result!.host).toBe("host-c:8080");

    mathRandomSpy.mockRestore();
  });

  test("round-robin strategy picks host by modulo of counter", async () => {
    mockRedisSend.mockImplementation(
      ((cmd: string, _args: string[]) => {
        if (cmd === "GETEX") return Promise.resolve(null);
        if (cmd === "INCR") return Promise.resolve(3);
        if (cmd === "SET") return Promise.resolve("OK");
        if (cmd === "EVAL") return Promise.resolve(1);
        return Promise.resolve(null);
      }) as any,
    );

    const hosts = ["host-a:8080", "host-b:8080", "host-c:8080"];
    const result = await selectHost("round-robin", makeInput({ hosts }));

    expect(result).toBeDefined();
    // counter=3, 3 % 3 = 0 -> host-a:8080
    expect(result!.host).toBe("host-a:8080");
  });

  test("least-connections strategy picks host with lowest count", async () => {
    mockRedisSend.mockImplementation(
      ((cmd: string, _args: string[]) => {
        if (cmd === "GETEX") return Promise.resolve(null);
        if (cmd === "MGET") return Promise.resolve(["5", "2", "8"]);
        if (cmd === "SET") return Promise.resolve("OK");
        if (cmd === "EVAL") return Promise.resolve(1);
        if (cmd === "DECR") return Promise.resolve(0);
        return Promise.resolve(null);
      }) as any,
    );

    const hosts = ["host-a:8080", "host-b:8080", "host-c:8080"];
    const result = await selectHost("least-connections", makeInput({ hosts }));

    expect(result).toBeDefined();
    // counts: a=5, b=2, c=8 -> b is lowest
    expect(result!.host).toBe("host-b:8080");
  });

  test("least-connections release calls DECR", async () => {
    const result = await selectHost("least-connections", makeInput());
    expect(result).toBeDefined();

    mockRedisSend.mockClear();
    mockRedisSend.mockImplementation(
      ((cmd: string, _args: string[]) => {
        if (cmd === "DECR") return Promise.resolve(0);
        return Promise.resolve(null);
      }) as any,
    );

    result!.release();

    // Allow the promise in release to settle
    await new Promise((r) => setTimeout(r, 50));

    const decrCalls = mockRedisSend.mock.calls.filter(
      ([cmd]: any) => cmd === "DECR",
    );
    expect(decrCalls).toHaveLength(1);
    expect((decrCalls[0] as any)[1][0]).toContain("lb:conn:");
  });

  test("redis failure in round-robin falls back to random", async () => {
    mockRedisSend.mockImplementation(
      ((cmd: string, _args: string[]) => {
        if (cmd === "GETEX") return Promise.resolve(null);
        if (cmd === "INCR") return Promise.reject(new Error("Redis down"));
        if (cmd === "SET") return Promise.resolve("OK");
        if (cmd === "EVAL") return Promise.resolve(1);
        return Promise.resolve(null);
      }) as any,
    );

    const result = await selectHost("round-robin", makeInput());
    expect(result).toBeDefined();
    expect(["host-a:8080", "host-b:8080"]).toContain(result!.host);
  });
});
