import { describe, test, expect, beforeEach, spyOn, afterEach } from "bun:test";
import { cache } from "../cache";
import type { SelectHostInput } from "./load-balancer";
const { admissionLimit, admit, selectHost } = await import("./load-balancer");

let mget: ReturnType<typeof spyOn<typeof cache, "mget">>;
let incr: ReturnType<typeof spyOn<typeof cache, "incr">>;
let set: ReturnType<typeof spyOn<typeof cache, "set">>;
let decr: ReturnType<typeof spyOn<typeof cache, "decr">>;
let tryIncr: ReturnType<typeof spyOn<typeof cache, "tryIncr">>;

function mgetReturning(prefixHints: (string | null)[], connCounts: (string | null)[] = ["0", "0"]) {
  mget.mockImplementation(async (keys) => (keys[0]?.startsWith("lb:prefix:") ? prefixHints : connCounts));
}

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
  mget = spyOn(cache, "mget").mockResolvedValue(["0", "0"]);
  incr = spyOn(cache, "incr").mockResolvedValue(1);
  set = spyOn(cache, "set").mockResolvedValue();
  decr = spyOn(cache, "decr").mockResolvedValue();
  tryIncr = spyOn(cache, "tryIncr").mockResolvedValue(true);
});

afterEach(() => {
  for (const spy of [mget, incr, set, decr, tryIncr]) {
    spy.mockRestore();
  }
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

  test("rolled final bucket without hosts falls back to early", async () => {
    const mathRandomSpy = spyOn(Math, "random").mockReturnValue(0);

    const result = await selectHost(
      "random",
      makeInput({ hosts: [], canaryProgress: 100, hasEarlyModel: true }),
    );
    expect(result).toBeDefined();
    expect(result!.useFinalModel).toBe(false);
    expect(result!.host).toBe("host-c:8080");

    mathRandomSpy.mockRestore();
  });

  test("rolled early bucket without hosts falls back to final", async () => {
    const mathRandomSpy = spyOn(Math, "random").mockReturnValue(0.5);

    const result = await selectHost(
      "random",
      makeInput({ earlyHosts: [], canaryProgress: 0, hasEarlyModel: true }),
    );
    expect(result).toBeDefined();
    expect(result!.useFinalModel).toBe(true);
    expect(["host-a:8080", "host-b:8080"]).toContain(result!.host);

    mathRandomSpy.mockRestore();
  });

  test("both canary buckets empty returns undefined", async () => {
    const result = await selectHost(
      "random",
      makeInput({ hosts: [], earlyHosts: [], canaryProgress: 50, hasEarlyModel: true }),
    );
    expect(result).toBeUndefined();
  });

  test("round-robin strategy picks host by modulo of counter", async () => {
    incr.mockResolvedValue(3);

    const hosts = ["host-a:8080", "host-b:8080", "host-c:8080"];
    const result = await selectHost("round-robin", makeInput({ hosts }));

    expect(result).toBeDefined();
    // counter=3, 3 % 3 = 0 -> host-a:8080
    expect(result!.host).toBe("host-a:8080");
  });

  test("least-connections strategy picks host with lowest count", async () => {
    mget.mockResolvedValue(["5", "2", "8"]);

    const hosts = ["host-a:8080", "host-b:8080", "host-c:8080"];
    const result = await selectHost("least-connections", makeInput({ hosts }));

    expect(result).toBeDefined();
    // counts: a=5, b=2, c=8 -> b is lowest
    expect(result!.host).toBe("host-b:8080");
  });

  test("least-connections release calls DECR", async () => {
    const result = await selectHost("least-connections", makeInput());
    expect(result).toBeDefined();

    result!.release();

    // Allow the promise in release to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(decr).toHaveBeenCalledTimes(1);
    expect(decr.mock.calls[0]![0]).toContain("lb:conn:");
  });

  test("cache failure in round-robin falls back to random", async () => {
    incr.mockRejectedValue(new Error("cache down"));

    const result = await selectHost("round-robin", makeInput());
    expect(result).toBeDefined();
    expect(["host-a:8080", "host-b:8080"]).toContain(result!.host);
  });
});

describe("prefix hint routing", () => {
  test("random strategy returns hint host when present", async () => {
    mgetReturning(["host-b:8080"]);

    const result = await selectHost("random", makeInput({
      prefixHashes: ["abc123"],
    }));
    expect(result).toBeDefined();
    expect(result!.host).toBe("host-b:8080");
  });

  test("random strategy ignores hint host not in pool", async () => {
    mgetReturning(["gone-host:8080"]);

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
    // host-a=3, host-b=5 (within margin of 2 from min 3)
    mgetReturning(["host-b:8080"], ["3", "5"]);

    const result = await selectHost("least-connections", makeInput({
      prefixHashes: ["abc123"],
    }));
    expect(result).toBeDefined();
    expect(result!.host).toBe("host-b:8080");
  });

  test("least-connections ignores hint host over margin", async () => {
    // host-a=0, host-b=5 (over margin of 2 from min 0)
    mgetReturning(["host-b:8080"], ["0", "5"]);

    const result = await selectHost("least-connections", makeInput({
      prefixHashes: ["abc123"],
    }));
    expect(result).toBeDefined();
    expect(result!.host).toBe("host-a:8080");
  });

  test("round-robin ignores hint host", async () => {
    mgetReturning(["host-b:8080"]);
    incr.mockResolvedValue(2);

    const result = await selectHost("round-robin", makeInput({
      prefixHashes: ["abc123"],
    }));
    expect(result).toBeDefined();
    // counter=2, 2 % 2 = 0 -> host-a, not host-b (hint ignored)
    expect(result!.host).toBe("host-a:8080");
  });

  test("cascade picks first matching hash (longest prefix)", async () => {
    // First hash (longest) misses, second hits
    mgetReturning([null, "host-a:8080"]);

    const result = await selectHost("random", makeInput({
      prefixHashes: ["long-hash", "short-hash"],
    }));
    expect(result).toBeDefined();
    expect(result!.host).toBe("host-a:8080");
  });

  test("stores full hash after selection", async () => {
    mgetReturning([null]);

    const result = await selectHost("random", makeInput({
      prefixHashes: ["full-hash", "partial-hash"],
    }));
    expect(result).toBeDefined();

    expect(set).toHaveBeenCalledWith("lb:prefix:full-hash", result!.host, 300);
  });

  test("cache failure in prefix lookup falls back to strategy", async () => {
    mget.mockImplementation(async (keys) => {
      if (keys[0]?.startsWith("lb:prefix:")) {
        throw new Error("cache down");
      }
      return ["0", "0"];
    });

    const result = await selectHost("random", makeInput({
      prefixHashes: ["abc123"],
    }));
    expect(result).toBeDefined();
    expect(["host-a:8080", "host-b:8080"]).toContain(result!.host);
  });

  test("no prefixHashes skips prefix lookup entirely", async () => {
    await selectHost("random", makeInput());

    const prefixMgets = mget.mock.calls.filter(([keys]) => keys[0]?.startsWith("lb:prefix:"));
    expect(prefixMgets).toHaveLength(0);
  });
});

describe("admit", () => {
  test("admits the engine's batch plus a quarter of it, at least one", () => {
    expect(admissionLimit(64)).toBe(80);
    expect(admissionLimit(1)).toBe(2);
  });

  test("passes the limit to the cache and releases the slot once", async () => {
    const release = await admit("inst-1", 64);
    expect(release).toBeDefined();
    expect(tryIncr.mock.calls[0]?.slice(0, 2)).toEqual(["lb:admitted:inst-1", 80]);
    release!();
    release!();
    expect(decr).toHaveBeenCalledTimes(1);
  });

  test("refuses once the cache reports the installation full", async () => {
    tryIncr.mockResolvedValue(false);
    expect(await admit("inst-1", 64)).toBeUndefined();
  });

  test("admits without a limit and when the cache fails", async () => {
    expect(await admit("inst-1", null)).toBeDefined();
    tryIncr.mockRejectedValue(new Error("down"));
    expect(await admit("inst-1", 64)).toBeDefined();
  });
});
