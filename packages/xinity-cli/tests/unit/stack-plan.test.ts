import { describe, expect, test, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { createTempDir, redirectXdgConfigHome, type TempDir } from "../helpers/temp-config.ts";
import type { Host } from "../../src/lib/host.ts";
import type { Manifest, StackMembership } from "../../src/lib/manifest.ts";
import type { Component } from "../../src/lib/component-meta.ts";
import { createStack, type StackDefinition } from "../../src/lib/stack.ts";
import { loadStackState, markHostManaged } from "../../src/lib/stack-state.ts";

// bun shares the module registry across test files, so the originals are
// captured first and restored in afterAll; the module under test is imported
// only after the mocks are installed.
const actualRemoteHost = { ...(await import("../../src/lib/remote-host.ts")) };
const actualManifest = { ...(await import("../../src/lib/manifest.ts")) };
const actualGithub = { ...(await import("../../src/lib/github.ts")) };
const actualInstallRemove = { ...(await import("../../src/lib/install-remove.ts")) };
const actualUpPlan = { ...(await import("../../src/lib/up-plan.ts")) };
let reachable: Set<string>;
let manifests: Record<string, Manifest>;
let removals: { component: Component; address: string }[];
let removalFails: boolean;
let membershipWrites: { address: string; membership: StackMembership | null }[];

function hostAddress(host: Host): string {
  return (host as unknown as { address: string }).address;
}

function fakeHost(address: string): Host {
  return {
    address,
    prepareElevation: async () => true,
    dispose: async () => {},
  } as unknown as Host;
}

mock.module("../../src/lib/remote-host.ts", () => ({
  ...actualRemoteHost,
  connectHost: async (address?: string) => {
    const addr = address ?? "local";
    if (!reachable.has(addr)) {
      throw new Error(`no route to ${addr}`);
    }
    return fakeHost(addr);
  },
}));

mock.module("../../src/lib/manifest.ts", () => ({
  ...actualManifest,
  readManifest: async (host: Host) => manifests[hostAddress(host)] ?? { components: {} },
  saveStackMembership: async (membership: StackMembership | null, host: Host) => {
    membershipWrites.push({ address: hostAddress(host), membership });
  },
}));

mock.module("../../src/lib/github.ts", () => ({
  ...actualGithub,
  fetchRelease: async () => ({ tagName: "v9.9.9" }),
}));

mock.module("../../src/lib/install-remove.ts", () => ({
  ...actualInstallRemove,
  removeComponentCollapsed: async (opts: { component: Component; host: Host }) => {
    removals.push({ component: opts.component, address: hostAddress(opts.host) });
    return removalFails
      ? { success: false, errors: ["simulated removal failure"] }
      : { success: true, errors: [] };
  },
}));

let gateApproves: boolean;

mock.module("../../src/lib/up-plan.ts", () => ({
  ...actualUpPlan,
  reviewGate: async () => gateApproves,
}));

const { runStackFlow } = await import("../../src/lib/stack-plan.ts");

afterAll(() => {
  mock.module("../../src/lib/remote-host.ts", () => actualRemoteHost);
  mock.module("../../src/lib/manifest.ts", () => actualManifest);
  mock.module("../../src/lib/github.ts", () => actualGithub);
  mock.module("../../src/lib/install-remove.ts", () => actualInstallRemove);
  mock.module("../../src/lib/up-plan.ts", () => actualUpPlan);
});

function daemonEntry(): Manifest["components"] {
  return { daemon: { version: "v1.0.0", installedAt: "2026-01-01", binaryPath: "/opt/xinity/daemon", unitName: "xinity-ai-daemon" } };
}

// Shared values keep ensureStackLevelConfig from opening an interactive
// editor; dbMigratedVersion matches the mocked release so no migrations plan.
function makeStack(name: string): StackDefinition {
  const stack = createStack(name, "v9.9.9");
  stack.secrets = {
    DB_CONNECTION_URL: "postgresql://localhost/db",
    REDIS_URL: "redis://localhost:6379",
    METRICS_AUTH: "user:pass",
  };
  stack.dbMigratedVersion = "v9.9.9";
  return stack;
}

describe("runStackFlow", () => {
  let tmp: TempDir;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmp = createTempDir("stack-plan-test");
    restoreEnv = redirectXdgConfigHome(tmp);
    reachable = new Set();
    manifests = {};
    removals = [];
    removalFails = false;
    membershipWrites = [];
    gateApproves = true;
  });

  afterEach(() => {
    restoreEnv();
    tmp.cleanup();
  });

  test("an empty stack with nothing tracked deploys nothing and succeeds", async () => {
    expect(await runStackFlow(createStack("empty", "v9.9.9"), { targetVersion: "latest" })).toBe(true);
    expect(removals).toEqual([]);
  });

  test("rejects an invalid definition before touching any host", async () => {
    const stack = makeStack("s0");
    stack.hosts = [
      { address: "10.0.0.1", components: ["daemon"] },
      { address: "10.0.0.1", components: ["daemon"] },
    ];
    expect(await runStackFlow(stack, { targetVersion: "latest" })).toBe(false);
    expect(removals).toEqual([]);
    expect(membershipWrites).toEqual([]);
  });

  test("an unreachable orphan is forgotten and does not fail the run", async () => {
    markHostManaged("s1", "10.0.0.5");

    expect(await runStackFlow(makeStack("s1"), { targetVersion: "latest" })).toBe(true);
    expect(loadStackState("s1").hosts).toEqual([]);
    expect(removals).toEqual([]);
  });

  test("an orphan claimed by another stack is left untouched", async () => {
    markHostManaged("s2", "10.0.0.6");
    reachable = new Set(["10.0.0.6"]);
    manifests["10.0.0.6"] = { components: daemonEntry(), stack: { name: "other" } };

    expect(await runStackFlow(makeStack("s2"), { targetVersion: "latest" })).toBe(true);
    expect(loadStackState("s2").hosts).toEqual([]);
    expect(removals).toEqual([]);
    expect(membershipWrites).toEqual([]);
  });

  test("an orphan with nothing installed is forgotten silently", async () => {
    markHostManaged("s3", "10.0.0.7");
    reachable = new Set(["10.0.0.7"]);
    manifests["10.0.0.7"] = { components: {} };

    expect(await runStackFlow(makeStack("s3"), { targetVersion: "latest" })).toBe(true);
    expect(loadStackState("s3").hosts).toEqual([]);
    expect(removals).toEqual([]);
  });

  test("a removed host is evacuated: components removed, membership and state cleared", async () => {
    markHostManaged("s4", "10.0.0.8");
    reachable = new Set(["10.0.0.8"]);
    manifests["10.0.0.8"] = { components: daemonEntry(), stack: { name: "s4" } };

    expect(await runStackFlow(makeStack("s4"), { targetVersion: "latest" })).toBe(true);
    expect(removals).toEqual([{ component: "daemon", address: "10.0.0.8" }]);
    expect(membershipWrites).toEqual([{ address: "10.0.0.8", membership: null }]);
    expect(loadStackState("s4").hosts).toEqual([]);
  });

  test("a failed evacuation keeps the state entry so the next up retries", async () => {
    markHostManaged("s5", "10.0.0.9");
    reachable = new Set(["10.0.0.9"]);
    manifests["10.0.0.9"] = { components: daemonEntry(), stack: { name: "s5" } };
    removalFails = true;

    expect(await runStackFlow(makeStack("s5"), { targetVersion: "latest" })).toBe(false);
    expect(membershipWrites).toEqual([]);
    expect(loadStackState("s5").hosts).toEqual([{ address: "10.0.0.9" }]);
  });

  test("a dry run plans an evacuation but changes neither hosts nor state", async () => {
    markHostManaged("s6", "10.0.0.10");
    reachable = new Set(["10.0.0.10"]);
    manifests["10.0.0.10"] = { components: daemonEntry(), stack: { name: "s6" } };

    expect(await runStackFlow(makeStack("s6"), { targetVersion: "latest", dryRun: true })).toBe(true);
    expect(removals).toEqual([]);
    expect(membershipWrites).toEqual([]);
    expect(loadStackState("s6").hosts).toEqual([{ address: "10.0.0.10" }]);
  });

  test("aborting at the gate leaves hosts and state untouched", async () => {
    gateApproves = false;
    markHostManaged("s7", "10.0.0.11");
    reachable = new Set(["10.0.0.11"]);
    manifests["10.0.0.11"] = { components: daemonEntry(), stack: { name: "s7" } };

    expect(await runStackFlow(makeStack("s7"), { targetVersion: "latest" })).toBe(true);
    expect(removals).toEqual([]);
    expect(membershipWrites).toEqual([]);
    expect(loadStackState("s7").hosts).toEqual([{ address: "10.0.0.11" }]);
  });

  test("an unreachable orphan is only forgotten after the gate approves", async () => {
    gateApproves = false;
    markHostManaged("s8", "10.0.0.12");

    expect(await runStackFlow(makeStack("s8"), { targetVersion: "latest" })).toBe(true);
    expect(loadStackState("s8").hosts).toEqual([{ address: "10.0.0.12" }]);
  });

});
