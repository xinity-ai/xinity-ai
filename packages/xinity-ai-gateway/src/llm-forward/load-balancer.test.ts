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
    publicModel: "my-model",
    ...overrides,
  };
}

beforeEach(() => {
  mockRedisSend = spyOn(redis, "send").mockImplementation(
    ((cmd: string, _args: string[]) => {
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

  test("random strategy distributes across hosts", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const result = await selectHost("random", makeInput());
      expect(result).toBeDefined();
      seen.add(result!.host);
    }
    expect(seen.size).toBe(2);
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
        if (cmd === "EVAL") return Promise.resolve(3);
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
        if (cmd === "MGET") return Promise.resolve(["5", "2", "8"]);
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
        if (cmd === "EVAL") return Promise.reject(new Error("Redis down"));
        return Promise.resolve(null);
      }) as any,
    );

    const result = await selectHost("round-robin", makeInput());
    expect(result).toBeDefined();
    expect(["host-a:8080", "host-b:8080"]).toContain(result!.host);
  });
});

describe("prefix hint routing", () => {
  test("random strategy returns hint host when present", async () => {
    mockRedisSend.mockImplementation(
      ((cmd: string, args: string[]) => {
        if (cmd === "MGET") {
          const keys = args as string[];
          if (keys[0]?.startsWith("lb:prefix:")) {
            return Promise.resolve(["host-b:8080"]);
          }
          return Promise.resolve(["0", "0"]);
        }
        if (cmd === "SET") return Promise.resolve("OK");
        return Promise.resolve(null);
      }) as any,
    );

    const result = await selectHost("random", makeInput({
      prefixHashes: ["abc123"],
    }));
    expect(result).toBeDefined();
    expect(result!.host).toBe("host-b:8080");
  });

  test("random strategy ignores hint host not in pool", async () => {
    mockRedisSend.mockImplementation(
      ((cmd: string, args: string[]) => {
        if (cmd === "MGET") {
          const keys = args as string[];
          if (keys[0]?.startsWith("lb:prefix:")) {
            return Promise.resolve(["gone-host:8080"]);
          }
          return Promise.resolve(["0", "0"]);
        }
        if (cmd === "SET") return Promise.resolve("OK");
        return Promise.resolve(null);
      }) as any,
    );

    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const result = await selectHost("random", makeInput({
        prefixHashes: ["abc123"],
      }));
      seen.add(result!.host);
    }
    expect(seen).not.toContain("gone-host:8080");
  });

  test("least-connections prefers hint host within margin", async () => {
    mockRedisSend.mockImplementation(
      ((cmd: string, args: string[]) => {
        if (cmd === "MGET") {
          const keys = args as string[];
          if (keys[0]?.startsWith("lb:prefix:")) {
            return Promise.resolve(["host-b:8080"]);
          }
          // host-a=3, host-b=5 (within margin of 2 from min 3)
          return Promise.resolve(["3", "5"]);
        }
        if (cmd === "SET") return Promise.resolve("OK");
        if (cmd === "EVAL") return Promise.resolve(1);
        if (cmd === "DECR") return Promise.resolve(0);
        return Promise.resolve(null);
      }) as any,
    );

    const result = await selectHost("least-connections", makeInput({
      prefixHashes: ["abc123"],
    }));
    expect(result).toBeDefined();
    expect(result!.host).toBe("host-b:8080");
  });

  test("least-connections ignores hint host over margin", async () => {
    mockRedisSend.mockImplementation(
      ((cmd: string, args: string[]) => {
        if (cmd === "MGET") {
          const keys = args as string[];
          if (keys[0]?.startsWith("lb:prefix:")) {
            return Promise.resolve(["host-b:8080"]);
          }
          // host-a=0, host-b=5 (over margin of 2 from min 0)
          return Promise.resolve(["0", "5"]);
        }
        if (cmd === "SET") return Promise.resolve("OK");
        if (cmd === "EVAL") return Promise.resolve(1);
        if (cmd === "DECR") return Promise.resolve(0);
        return Promise.resolve(null);
      }) as any,
    );

    const result = await selectHost("least-connections", makeInput({
      prefixHashes: ["abc123"],
    }));
    expect(result).toBeDefined();
    expect(result!.host).toBe("host-a:8080");
  });

  test("round-robin ignores hint host", async () => {
    mockRedisSend.mockImplementation(
      ((cmd: string, args: string[]) => {
        if (cmd === "MGET") {
          const keys = args as string[];
          if (keys[0]?.startsWith("lb:prefix:")) {
            return Promise.resolve(["host-b:8080"]);
          }
          return Promise.resolve(["0", "0"]);
        }
        if (cmd === "SET") return Promise.resolve("OK");
        if (cmd === "EVAL") return Promise.resolve(2);
        return Promise.resolve(null);
      }) as any,
    );

    const result = await selectHost("round-robin", makeInput({
      prefixHashes: ["abc123"],
    }));
    expect(result).toBeDefined();
    // counter=2, 2 % 2 = 0 -> host-a, not host-b (hint ignored)
    expect(result!.host).toBe("host-a:8080");
  });

  test("cascade picks first matching hash (longest prefix)", async () => {
    mockRedisSend.mockImplementation(
      ((cmd: string, args: string[]) => {
        if (cmd === "MGET") {
          const keys = args as string[];
          if (keys[0]?.startsWith("lb:prefix:")) {
            // First hash (longest) misses, second hits
            return Promise.resolve([null, "host-a:8080"]);
          }
          return Promise.resolve(["0", "0"]);
        }
        if (cmd === "SET") return Promise.resolve("OK");
        return Promise.resolve(null);
      }) as any,
    );

    const result = await selectHost("random", makeInput({
      prefixHashes: ["long-hash", "short-hash"],
    }));
    expect(result).toBeDefined();
    expect(result!.host).toBe("host-a:8080");
  });

  test("stores full hash after selection", async () => {
    const setCalls: string[][] = [];
    mockRedisSend.mockImplementation(
      ((cmd: string, args: string[]) => {
        if (cmd === "MGET") {
          const keys = args as string[];
          if (keys[0]?.startsWith("lb:prefix:")) {
            return Promise.resolve([null]);
          }
          return Promise.resolve(["0", "0"]);
        }
        if (cmd === "SET") {
          setCalls.push(args as string[]);
          return Promise.resolve("OK");
        }
        return Promise.resolve(null);
      }) as any,
    );

    const result = await selectHost("random", makeInput({
      prefixHashes: ["full-hash", "partial-hash"],
    }));
    expect(result).toBeDefined();

    const prefixSet = setCalls.find(a => a[0]?.startsWith("lb:prefix:"));
    expect(prefixSet).toBeDefined();
    expect(prefixSet![0]).toBe("lb:prefix:full-hash");
    expect(prefixSet![1]).toBe(result!.host);
    expect(prefixSet![2]).toBe("EX");
    expect(prefixSet![3]).toBe("300");
  });

  test("redis failure in prefix lookup falls back to strategy", async () => {
    let mgetCount = 0;
    mockRedisSend.mockImplementation(
      ((cmd: string, args: string[]) => {
        if (cmd === "MGET") {
          mgetCount++;
          const keys = args as string[];
          if (keys[0]?.startsWith("lb:prefix:")) {
            return Promise.reject(new Error("Redis down"));
          }
          return Promise.resolve(["0", "0"]);
        }
        if (cmd === "SET") return Promise.resolve("OK");
        return Promise.resolve(null);
      }) as any,
    );

    const result = await selectHost("random", makeInput({
      prefixHashes: ["abc123"],
    }));
    expect(result).toBeDefined();
    expect(["host-a:8080", "host-b:8080"]).toContain(result!.host);
  });

  test("no prefixHashes skips prefix lookup entirely", async () => {
    const mgetKeys: string[][] = [];
    mockRedisSend.mockImplementation(
      ((cmd: string, args: string[]) => {
        if (cmd === "MGET") {
          mgetKeys.push(args as string[]);
          return Promise.resolve(["0", "0"]);
        }
        if (cmd === "SET") return Promise.resolve("OK");
        return Promise.resolve(null);
      }) as any,
    );

    await selectHost("random", makeInput());

    const prefixMgets = mgetKeys.filter(k => k[0]?.startsWith("lb:prefix:"));
    expect(prefixMgets).toHaveLength(0);
  });
});
