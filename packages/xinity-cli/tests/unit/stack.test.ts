import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createTempDir, redirectXdgConfigHome, type TempDir } from "../helpers/temp-config.ts";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { version as cliVersion } from "../../../../package.json";
import {
  type StackDefinition,
  type StackHost,
  type FleetDefinition,
  resolveEnv,
  diffFromLayer,
  validateStack,
  getFleet,
  getHost,
  getFleetForHost,
  createStack,
  loadStack,
  saveStack,
  deleteStack,
  listStacks,
} from "../../src/lib/stack.ts";
import { loadStackState, markHostManaged } from "../../src/lib/stack-state.ts";

function makeStack(overrides: Partial<StackDefinition> = {}): StackDefinition {
  return {
    version: "0.0.0",
    name: "test-stack",
    env: {},
    secrets: {},
    componentEnv: {},
    hosts: [],
    fleets: [],
    ...overrides,
  };
}

function makeHost(overrides: Partial<StackHost> = {}): StackHost {
  return {
    address: "10.0.0.1",
    components: ["daemon"],
    ...overrides,
  };
}

function makeFleet(overrides: Partial<FleetDefinition> = {}): FleetDefinition {
  return {
    name: "gpu-pool",
    hosts: ["10.0.0.1"],
    ...overrides,
  };
}

// ── Persistence ──────────────────────────────────────────────────────────

describe("stack persistence", () => {
  let tmp: TempDir;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmp = createTempDir("stack-test");
    restoreEnv = redirectXdgConfigHome(tmp);
  });

  afterEach(() => {
    restoreEnv();
    tmp.cleanup();
  });

  function definitionPath(name: string): string {
    return join(tmp.path, "xinity", "stacks", `${name}.json`);
  }

  test("loadStack returns null when file does not exist", () => {
    expect(loadStack("nonexistent")).toBeNull();
  });

  test("loadStack returns null for invalid JSON", () => {
    tmp.write("xinity/stacks/broken.json", "not valid json{{{");
    expect(loadStack("broken")).toBeNull();
  });

  test("round-trips a stack definition, stamping the CLI version", () => {
    const stack = makeStack({
      env: { REDIS_URL: "redis://localhost:6379" },
      secrets: { DB_CONNECTION_URL: "postgresql://localhost/db" },
      hosts: [makeHost()],
      fleets: [makeFleet()],
    });

    saveStack(stack);
    const loaded = loadStack("test-stack");

    expect(loaded).toEqual({ ...stack, version: cliVersion });
  });

  test("saved stack files are readable only by the user", () => {
    saveStack(makeStack());
    expect(statSync(definitionPath("test-stack")).mode & 0o777).toBe(0o600);
  });

  test("loadStack backfills fields missing from older files", () => {
    tmp.write("xinity/stacks/old.json", JSON.stringify({ name: "old", env: { A: "1" } }));

    expect(loadStack("old")).toEqual({
      ...createStack("old"),
      version: "0.0.0",
      env: { A: "1" },
    });
  });

  test("saveStack never persists derivedEnv", () => {
    const stack = makeStack({ derivedEnv: { INFOSERVER_URL: "http://10.0.0.1:8090" } });
    saveStack(stack);

    const written = JSON.parse(readFileSync(definitionPath("test-stack"), "utf-8")) as Record<string, unknown>;
    expect(written.derivedEnv).toBeUndefined();
    expect(loadStack("test-stack")?.derivedEnv).toBeUndefined();
  });

  test("deleteStack removes the definition and its state", () => {
    saveStack(makeStack());
    markHostManaged("test-stack", "10.0.0.9");
    expect(loadStackState("test-stack").hosts).toEqual([{ address: "10.0.0.9" }]);

    expect(deleteStack("test-stack")).toBe(true);
    expect(loadStack("test-stack")).toBeNull();
    expect(loadStackState("test-stack").hosts).toEqual([]);
  });

  test("deleteStack returns false when file does not exist", () => {
    expect(deleteStack("nonexistent")).toBe(false);
  });

  test("listStacks returns sorted stack names", () => {
    saveStack(makeStack({ name: "bravo" }));
    saveStack(makeStack({ name: "alpha" }));
    saveStack(makeStack({ name: "charlie" }));

    expect(listStacks()).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("listStacks returns empty array when directory does not exist", () => {
    expect(listStacks()).toEqual([]);
  });

  test("listStacks ignores non-JSON files", () => {
    tmp.write("xinity/stacks/notes.txt", "not a stack");
    saveStack(makeStack({ name: "real" }));

    expect(listStacks()).toEqual(["real"]);
  });
});

// ── Lookup ───────────────────────────────────────────────────────────────

describe("stack lookup", () => {
  test("getFleet returns matching fleet", () => {
    const fleet = makeFleet({ name: "a100" });
    const stack = makeStack({ fleets: [fleet, makeFleet({ name: "other" })] });

    expect(getFleet(stack, "a100")).toEqual(fleet);
  });

  test("getFleet returns null for unknown name", () => {
    const stack = makeStack({ fleets: [makeFleet()] });
    expect(getFleet(stack, "nonexistent")).toBeNull();
  });

  test("getHost returns matching host", () => {
    const host = makeHost({ address: "10.0.0.5" });
    const stack = makeStack({ hosts: [makeHost(), host] });

    expect(getHost(stack, "10.0.0.5")).toEqual(host);
  });

  test("getHost returns null for unknown address", () => {
    const stack = makeStack({ hosts: [makeHost()] });
    expect(getHost(stack, "10.0.0.99")).toBeNull();
  });

  test("getFleetForHost returns fleet containing the host", () => {
    const fleet = makeFleet({ name: "pool", hosts: ["10.0.0.1", "10.0.0.2"] });
    const stack = makeStack({
      hosts: [makeHost({ address: "10.0.0.1" }), makeHost({ address: "10.0.0.2" })],
      fleets: [fleet],
    });

    expect(getFleetForHost(stack, "10.0.0.2")?.name).toBe("pool");
  });

  test("getFleetForHost returns null when host is not in any fleet", () => {
    const stack = makeStack({
      hosts: [makeHost({ address: "10.0.0.1" })],
      fleets: [makeFleet({ hosts: ["10.0.0.99"] })],
    });

    expect(getFleetForHost(stack, "10.0.0.1")).toBeNull();
  });
});

// ── Env resolution ───────────────────────────────────────────────────────

describe("resolveEnv", () => {
  test("shared env and secrets reach every component", () => {
    const stack = makeStack({
      env: { REDIS_URL: "redis://localhost:6379" },
      secrets: { DB_CONNECTION_URL: "postgresql://localhost/db" },
    });

    expect(resolveEnv(stack, "gateway")).toMatchObject({
      REDIS_URL: "redis://localhost:6379",
      DB_CONNECTION_URL: "postgresql://localhost/db",
    });
    expect(resolveEnv(stack, "daemon")).toMatchObject({
      DB_CONNECTION_URL: "postgresql://localhost/db",
    });
  });

  test("includes the component's auto defaults as the base layer", () => {
    const stack = makeStack();
    expect(resolveEnv(stack, "daemon").STATE_DIR).toBe("/var/lib/xinity-ai-daemon");
    expect(resolveEnv(stack, "gateway").INFOSERVER_URL).toBe("https://sysinfo.xinity.ai");
  });

  test("shared env overrides auto defaults", () => {
    const stack = makeStack({ env: { INFOSERVER_URL: "http://infoserver.internal:8090" } });
    expect(resolveEnv(stack, "gateway").INFOSERVER_URL).toBe("http://infoserver.internal:8090");
  });

  test("derivedEnv sits above auto defaults but below explicit shared env", () => {
    const derived = makeStack({ derivedEnv: { INFOSERVER_URL: "http://10.0.0.9:8090" } });
    expect(resolveEnv(derived, "gateway").INFOSERVER_URL).toBe("http://10.0.0.9:8090");

    const overridden = makeStack({
      derivedEnv: { INFOSERVER_URL: "http://10.0.0.9:8090" },
      env: { INFOSERVER_URL: "http://public.example:8090" },
    });
    expect(resolveEnv(overridden, "gateway").INFOSERVER_URL).toBe("http://public.example:8090");
  });

  test("componentEnv applies only to its own component type", () => {
    const stack = makeStack({
      componentEnv: { gateway: { PORT: "9000" } },
    });

    expect(resolveEnv(stack, "gateway").PORT).toBe("9000");
    expect(resolveEnv(stack, "dashboard").PORT).toBeUndefined();
  });

  test("fleet overrides apply to the daemon on fleet hosts only", () => {
    const stack = makeStack({
      env: { CIDR_PREFIX: "10.0" },
      hosts: [makeHost({ address: "10.0.0.1", components: ["daemon", "gateway"] })],
      fleets: [makeFleet({ hosts: ["10.0.0.1"], envOverrides: { CIDR_PREFIX: "172.16" } })],
    });

    expect(resolveEnv(stack, "daemon", "10.0.0.1").CIDR_PREFIX).toBe("172.16");
    expect(resolveEnv(stack, "gateway", "10.0.0.1").CIDR_PREFIX).toBe("10.0");
  });

  test("full precedence chain: shared < componentEnv < fleet < host", () => {
    const stack = makeStack({
      env: { A: "stack", B: "stack", C: "stack", D: "stack" },
      secrets: { S: "stack-secret" },
      componentEnv: { daemon: { B: "component", C: "component", D: "component" } },
      hosts: [makeHost({ address: "h1", envOverrides: { D: "host" } })],
      fleets: [makeFleet({ hosts: ["h1"], envOverrides: { C: "fleet", D: "fleet" } })],
    });

    const result = resolveEnv(stack, "daemon", "h1");
    expect(result.A).toBe("stack");
    expect(result.B).toBe("component");
    expect(result.C).toBe("fleet");
    expect(result.D).toBe("host");
    expect(result.S).toBe("stack-secret");
  });

  test("host without a fleet gets no fleet layer", () => {
    const stack = makeStack({
      env: { KEY: "value" },
      hosts: [makeHost({ address: "10.0.0.1" })],
      fleets: [makeFleet({ hosts: ["10.0.0.9"], envOverrides: { KEY: "fleet" } })],
    });

    expect(resolveEnv(stack, "daemon", "10.0.0.1").KEY).toBe("value");
  });
});

describe("diffFromLayer", () => {
  test("keeps only entries that differ from the base", () => {
    expect(diffFromLayer(
      { A: "same", B: "changed", C: "new" },
      { A: "same", B: "original" },
    )).toEqual({ B: "changed", C: "new" });
  });

  test("identical values produce an empty diff", () => {
    expect(diffFromLayer({ A: "x" }, { A: "x" })).toEqual({});
  });
});

// ── Validation ───────────────────────────────────────────────────────────

describe("validateStack", () => {
  test("valid stack produces no errors", () => {
    const stack = makeStack({
      name: "production",
      hosts: [makeHost({ address: "10.0.0.1", components: ["daemon"] })],
      fleets: [makeFleet({ name: "gpu", hosts: ["10.0.0.1"] })],
    });

    expect(validateStack(stack)).toEqual([]);
  });

  test("rejects a host that belongs to multiple fleets", () => {
    const stack = makeStack({
      name: "production",
      hosts: [makeHost({ address: "10.0.0.1", components: ["daemon"] })],
      fleets: [
        makeFleet({ name: "pool-a", hosts: ["10.0.0.1"] }),
        makeFleet({ name: "pool-b", hosts: ["10.0.0.1"] }),
      ],
    });

    const errors = validateStack(stack);
    expect(errors.some((e) => e.message.includes("multiple fleets"))).toBe(true);
  });

  test("rejects invalid stack name", () => {
    const stack = makeStack({ name: "INVALID NAME!" });
    const errors = validateStack(stack);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("name");
  });

  test("rejects empty stack name", () => {
    const stack = makeStack({ name: "" });
    const errors = validateStack(stack);

    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  test("accepts hyphenated and underscored names", () => {
    expect(validateStack(makeStack({ name: "my-stack" }))).toEqual([]);
    expect(validateStack(makeStack({ name: "my_stack" }))).toEqual([]);
    expect(validateStack(makeStack({ name: "prod-01" }))).toEqual([]);
  });

  test("rejects duplicate host addresses", () => {
    const stack = makeStack({
      hosts: [
        makeHost({ address: "10.0.0.1" }),
        makeHost({ address: "10.0.0.1" }),
      ],
    });
    const errors = validateStack(stack);

    expect(errors.some((e) => e.message.includes("Duplicate host"))).toBe(true);
  });

  test("rejects host with no components", () => {
    const stack = makeStack({
      hosts: [makeHost({ address: "10.0.0.1", components: [] })],
    });
    const errors = validateStack(stack);

    expect(errors.some((e) => e.message.includes("no components"))).toBe(true);
  });

  test("rejects fleet referencing unknown host", () => {
    const stack = makeStack({
      hosts: [makeHost({ address: "10.0.0.1" })],
      fleets: [makeFleet({ hosts: ["10.0.0.99"] })],
    });
    const errors = validateStack(stack);

    expect(errors.some((e) => e.message.includes("unknown host"))).toBe(true);
  });

  test("rejects duplicate fleet names", () => {
    const stack = makeStack({
      hosts: [makeHost()],
      fleets: [
        makeFleet({ name: "pool" }),
        makeFleet({ name: "pool" }),
      ],
    });
    const errors = validateStack(stack);

    expect(errors.some((e) => e.message.includes("Duplicate fleet"))).toBe(true);
  });

  test("warns when fleet hosts lack daemon component", () => {
    const stack = makeStack({
      hosts: [makeHost({ address: "10.0.0.1", components: ["gateway"] })],
      fleets: [makeFleet({ hosts: ["10.0.0.1"] })],
    });
    const errors = validateStack(stack);

    expect(errors.some((e) => e.message.includes("no hosts with the daemon"))).toBe(true);
  });
});

// ── Factory ──────────────────────────────────────────────────────────────

describe("createStack", () => {
  test("returns an empty stack with the given name", () => {
    const stack = createStack("my-stack");

    expect(stack.name).toBe("my-stack");
    expect(stack.env).toEqual({});
    expect(stack.secrets).toEqual({});
    expect(stack.componentEnv).toEqual({});
    expect(stack.hosts).toEqual([]);
    expect(stack.fleets).toEqual([]);
    expect(stack.version).not.toBe("");
  });
});
