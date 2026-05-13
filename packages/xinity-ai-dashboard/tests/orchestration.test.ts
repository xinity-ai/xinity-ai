import { describe, test, expect } from "bun:test";
import { buildClusterState, collectExcessInstallations, findServerForModel, rankServers } from "../src/lib/server/lib/orchestration.mod";
import type { AiNode, ModelInstallation } from "common-db";
import type { ModelRequirementTable, DeploymentStrategy } from "../src/lib/server/lib/orchestration.mod";

const FF: DeploymentStrategy = "first-fit";

function makeNode(overrides: Partial<AiNode> & { id: string }): AiNode {
  return {
    host: "10.0.0.1",
    port: 9090,
    estCapacity: 24,
    available: true,
    drivers: ["ollama"],
    driverVersions: { ollama: "0.6.3" },
    gpus: [],
    gpuCount: 1,
    machineName: null,
    authToken: null,
    tls: false,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeInstallation(overrides: Partial<ModelInstallation> & { id: string; nodeId: string; specifier: string }): ModelInstallation {
  return {
    estCapacity: 8,
    kvCacheCapacity: 2,
    port: 11434,
    driver: "ollama",
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("orchestration: node goes unavailable", () => {
  const nodeA = makeNode({ id: "node-a", host: "10.0.0.1" });

  test("installations on a downed node are not counted, and replacement is planned on a healthy node", () => {
    // node-b just went offline — syncDeployedModels filters it out of availableServers
    // and partitions its installations as orphaned. We simulate that here:
    const availableServers = [nodeA];
    const allInstallations = [
      makeInstallation({ id: "inst-1", nodeId: "node-b", specifier: "llama2:7b" }),
    ];

    const availableServerIds = new Set(availableServers.map(s => s.id));
    const orphaned = allInstallations.filter(i => !availableServerIds.has(i.nodeId));
    const active = allInstallations.filter(i => availableServerIds.has(i.nodeId));

    // The installation on the dead node is orphaned
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe("inst-1");

    // Cluster state sees zero existing replicas for llama2:7b
    const state = buildClusterState(active, availableServers);
    expect(state.installationsByModel.has("llama2:7b")).toBe(false);

    // No excess to trim (nothing active)
    const requiredModels: ModelRequirementTable = {
      "llama2:7b": { specifier: "llama2:7b", replicas: 1, kvCacheSize: 2, preferredDriver: null },
    };
    const excess = collectExcessInstallations(requiredModels, state);
    expect(excess).toHaveLength(0);

    // Planner would place the replacement on node-a
    const replacement = findServerForModel("llama2:7b", "ollama", 8, state, [], FF);
    expect(replacement).toBe("node-a");
  });

  test("findServerForModel skips nodes missing the required driver", () => {
    const ollamaOnly = makeNode({ id: "node-c", host: "10.0.0.3", drivers: ["ollama"] });
    const state = buildClusterState([], [ollamaOnly]);

    expect(findServerForModel("some-model", "vllm", 8, state, [], FF)).toBeNull();
  });

  test("findServerForModel skips nodes without enough capacity", () => {
    const tinyNode = makeNode({ id: "node-d", host: "10.0.0.4", estCapacity: 4 });
    const state = buildClusterState([], [tinyNode]);

    expect(findServerForModel("big-model", "ollama", 16, state, [], FF)).toBeNull();
  });

  test("findServerForModel skips nodes with incompatible driver version", () => {
    const oldNode = makeNode({ id: "node-e", host: "10.0.0.5", drivers: ["vllm"], driverVersions: { vllm: "0.18.0" } });
    const state = buildClusterState([], [oldNode]);

    expect(findServerForModel("new-model", "vllm", 8, state, [], FF, "0.19.1")).toBeNull();
  });

  test("findServerForModel accepts nodes with sufficient driver version", () => {
    const newNode = makeNode({ id: "node-f", host: "10.0.0.6", drivers: ["vllm"], driverVersions: { vllm: "0.20.0" } });
    const state = buildClusterState([], [newNode]);

    expect(findServerForModel("new-model", "vllm", 8, state, [], FF, "0.19.1")).toBe("node-f");
  });

  test("findServerForModel skips nodes with unknown version (fail-closed)", () => {
    const unknownNode = makeNode({ id: "node-g", host: "10.0.0.7", drivers: ["vllm"], driverVersions: { vllm: "" } });
    const state = buildClusterState([], [unknownNode]);

    expect(findServerForModel("new-model", "vllm", 8, state, [], FF, "0.19.1")).toBeNull();
  });

  test("findServerForModel skips nodes with wrong GPU platform", () => {
    const amdNode = makeNode({ id: "node-h", host: "10.0.0.8", drivers: ["vllm"], driverVersions: { vllm: "0.20.0" }, gpus: [{ vendor: "amd", name: "MI300X", vramMb: 196608 }] });
    const state = buildClusterState([], [amdNode]);

    expect(findServerForModel("mxfp4-model", "vllm", 8, state, [], FF, undefined, ["nvidia"])).toBeNull();
  });

  test("findServerForModel accepts nodes with matching GPU platform", () => {
    const nvidiaNode = makeNode({ id: "node-i", host: "10.0.0.9", drivers: ["vllm"], driverVersions: { vllm: "0.20.0" }, gpus: [{ vendor: "nvidia", name: "A100", vramMb: 81920 }] });
    const state = buildClusterState([], [nvidiaNode]);

    expect(findServerForModel("mxfp4-model", "vllm", 8, state, [], FF, undefined, ["nvidia"])).toBe("node-i");
  });

  test("findServerForModel rejects nodes with no GPUs when platform is required", () => {
    const cpuNode = makeNode({ id: "node-j", host: "10.0.0.10", drivers: ["vllm"], driverVersions: { vllm: "0.20.0" }, gpus: [] });
    const state = buildClusterState([], [cpuNode]);

    expect(findServerForModel("mxfp4-model", "vllm", 8, state, [], FF, undefined, ["nvidia"])).toBeNull();
  });
});

describe("orchestration: specifier indexing", () => {
  const node = makeNode({ id: "node-1" });

  test("installation indexes under its specifier", () => {
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "llama-3.3-70b" });
    const state = buildClusterState([inst], [node]);
    expect(state.installationsByModel.has("llama-3.3-70b")).toBe(true);
  });

  test("findServerForModel skips a node that already hosts the specifier", () => {
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "llama-3.3-70b" });
    const state = buildClusterState([inst], [node]);
    expect(findServerForModel("llama-3.3-70b", "ollama", 8, state, [], FF)).toBeNull();
  });
});

describe("orchestration: deployment strategies", () => {
  const nodeA = makeNode({ id: "node-a", host: "10.0.0.1", estCapacity: 24 });
  const nodeB = makeNode({ id: "node-b", host: "10.0.0.2", estCapacity: 24 });
  const nodeC = makeNode({ id: "node-c", host: "10.0.0.3", estCapacity: 48 });

  // Pre-load A with 4GB used, B with 16GB used, C with 24GB used.
  // Free: A=20, B=8, C=24. Ratio used: A=4/24≈0.167, B=16/24≈0.667, C=24/48=0.5.
  const preinstalls = [
    makeInstallation({ id: "p-a", nodeId: "node-a", specifier: "x", estCapacity: 4 }),
    makeInstallation({ id: "p-b", nodeId: "node-b", specifier: "y", estCapacity: 16 }),
    makeInstallation({ id: "p-c", nodeId: "node-c", specifier: "z", estCapacity: 24 }),
  ];

  test("rankServers first-fit preserves DB order", () => {
    const state = buildClusterState(preinstalls, [nodeA, nodeB, nodeC]);
    expect(rankServers("first-fit", state).map(s => s.id)).toEqual(["node-a", "node-b", "node-c"]);
  });

  test("rankServers balanced orders by most absolute free first", () => {
    const state = buildClusterState(preinstalls, [nodeA, nodeB, nodeC]);
    // Free: A=20, B=8, C=24 -> C, A, B
    expect(rankServers("balanced", state).map(s => s.id)).toEqual(["node-c", "node-a", "node-b"]);
  });

  test("rankServers bin-pack orders by least free first", () => {
    const state = buildClusterState(preinstalls, [nodeA, nodeB, nodeC]);
    // Free: A=20, B=8, C=24 -> B, A, C
    expect(rankServers("bin-pack", state).map(s => s.id)).toEqual(["node-b", "node-a", "node-c"]);
  });

  test("rankServers proportional orders by lowest percent used first", () => {
    const state = buildClusterState(preinstalls, [nodeA, nodeB, nodeC]);
    // Ratio: A=0.167, B=0.667, C=0.5 -> A, C, B
    expect(rankServers("proportional", state).map(s => s.id)).toEqual(["node-a", "node-c", "node-b"]);
  });

  test("findServerForModel balanced picks node with most free capacity", () => {
    const state = buildClusterState(preinstalls, [nodeA, nodeB, nodeC]);
    expect(findServerForModel("new-model", "ollama", 4, state, [], "balanced")).toBe("node-c");
  });

  test("findServerForModel bin-pack picks tightest fit that still satisfies", () => {
    const state = buildClusterState(preinstalls, [nodeA, nodeB, nodeC]);
    // B has 8 free, the tightest that fits a 4GB model.
    expect(findServerForModel("new-model", "ollama", 4, state, [], "bin-pack")).toBe("node-b");
  });

  test("findServerForModel bin-pack skips nodes too tight to fit", () => {
    const state = buildClusterState(preinstalls, [nodeA, nodeB, nodeC]);
    // 10GB doesn't fit on B (8 free), so falls through to A (20 free), not C (24 free).
    expect(findServerForModel("big-model", "ollama", 10, state, [], "bin-pack")).toBe("node-a");
  });

  test("findServerForModel proportional picks lowest percent used", () => {
    const state = buildClusterState(preinstalls, [nodeA, nodeB, nodeC]);
    expect(findServerForModel("new-model", "ollama", 4, state, [], "proportional")).toBe("node-a");
  });

  test("balanced spreads replicas across nodes across consecutive placements", () => {
    // No preinstalls. Three equal-size nodes. Placing 3 replicas of a 4GB model with
    // balanced should land one on each, because the planner mutates serverCapacity
    // between placements and rankServers re-sorts each call.
    const empty = buildClusterState([], [nodeA, nodeB, nodeC]);
    const pending: Parameters<typeof findServerForModel>[4] = [];

    const first = findServerForModel("m", "ollama", 4, empty, pending, "balanced")!;
    empty.serverCapacity.get(first)!.used += 4;
    pending.push({ nodeId: first, specifier: "m", estCapacity: 4, kvCacheCapacity: 0, driver: "ollama", port: 11434 });

    const second = findServerForModel("m", "ollama", 4, empty, pending, "balanced")!;
    empty.serverCapacity.get(second)!.used += 4;
    pending.push({ nodeId: second, specifier: "m", estCapacity: 4, kvCacheCapacity: 0, driver: "ollama", port: 11434 });

    const third = findServerForModel("m", "ollama", 4, empty, pending, "balanced")!;

    expect(new Set([first, second, third])).toEqual(new Set(["node-a", "node-b", "node-c"]));
  });
});
