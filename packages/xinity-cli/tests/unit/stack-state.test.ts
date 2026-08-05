import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createTempDir, redirectXdgConfigHome, type TempDir } from "../helpers/temp-config.ts";
import { version as cliVersion } from "../../../../package.json";
import {
  type StackState,
  addManagedHost,
  removeManagedHost,
  findOrphanHosts,
  loadStackState,
  markHostManaged,
  unmarkHostManaged,
  deleteStackState,
} from "../../src/lib/stack-state.ts";
import { type StackDefinition, createStack } from "../../src/lib/stack.ts";

function makeState(addresses: string[] = []): StackState {
  return { version: "0.0.0", hosts: addresses.map((address) => ({ address })) };
}

function makeStack(addresses: string[] = []): StackDefinition {
  const stack = createStack("test-stack", "v1.0.0");
  stack.hosts = addresses.map((address) => ({ address, components: ["daemon"] }));
  return stack;
}

describe("addManagedHost", () => {
  test("adds a new host and reports the change", () => {
    const state = makeState(["10.0.0.1"]);
    expect(addManagedHost(state, "10.0.0.2")).toBe(true);
    expect(state.hosts).toEqual([{ address: "10.0.0.1" }, { address: "10.0.0.2" }]);
  });

  test("is a no-op for an already managed host", () => {
    const state = makeState(["10.0.0.1"]);
    expect(addManagedHost(state, "10.0.0.1")).toBe(false);
    expect(state.hosts).toHaveLength(1);
  });
});

describe("removeManagedHost", () => {
  test("removes a managed host and reports the change", () => {
    const state = makeState(["10.0.0.1", "10.0.0.2"]);
    expect(removeManagedHost(state, "10.0.0.1")).toBe(true);
    expect(state.hosts).toEqual([{ address: "10.0.0.2" }]);
  });

  test("is a no-op for an unknown host", () => {
    const state = makeState(["10.0.0.1"]);
    expect(removeManagedHost(state, "10.0.0.9")).toBe(false);
    expect(state.hosts).toHaveLength(1);
  });
});

describe("state persistence", () => {
  let tmp: TempDir;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmp = createTempDir("stack-state-test");
    restoreEnv = redirectXdgConfigHome(tmp);
  });

  afterEach(() => {
    restoreEnv();
    tmp.cleanup();
  });

  test("loadStackState returns an empty state when no file exists", () => {
    expect(loadStackState("fresh")).toEqual({ version: cliVersion, hosts: [] });
  });

  test("loadStackState falls back to an empty state for a corrupt file", () => {
    tmp.write("xinity/stacks/state/corrupt.json", "not valid json{{{");
    expect(loadStackState("corrupt")).toEqual({ version: cliVersion, hosts: [] });
  });

  test("loadStackState backfills fields missing from older files", () => {
    tmp.write("xinity/stacks/state/old.json", "{}");
    expect(loadStackState("old")).toEqual({ version: "0.0.0", hosts: [] });
  });

  test("mark and unmark round-trip through the real file", () => {
    markHostManaged("s", "10.0.0.1");
    markHostManaged("s", "10.0.0.2");
    markHostManaged("s", "10.0.0.1");
    expect(loadStackState("s").hosts).toEqual([{ address: "10.0.0.1" }, { address: "10.0.0.2" }]);

    unmarkHostManaged("s", "10.0.0.1");
    expect(loadStackState("s").hosts).toEqual([{ address: "10.0.0.2" }]);
  });

  test("deleteStackState removes the file", () => {
    markHostManaged("s", "10.0.0.1");
    deleteStackState("s");
    expect(loadStackState("s").hosts).toEqual([]);
    expect(tmp.exists("xinity/stacks/state/s.json")).toBe(false);
  });
});

describe("findOrphanHosts", () => {
  test("returns managed hosts missing from the definition", () => {
    const state = makeState(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
    const stack = makeStack(["10.0.0.2"]);
    expect(findOrphanHosts(state, stack)).toEqual(["10.0.0.1", "10.0.0.3"]);
  });

  test("hosts never applied to are not orphans", () => {
    const state = makeState([]);
    expect(findOrphanHosts(state, makeStack(["10.0.0.1"]))).toEqual([]);
  });
});
