import { describe, test, expect } from "bun:test";
import { buildClusterState, collectDriftedInstallations, collectExcessInstallations, collectReassignableOrphans, findServerForModel, mergeRequirementsBySpecifier, rankServers } from "../src/lib/server/lib/orchestration.mod";
import type { AiNode, ModelInstallation } from "common-db";
import type { ModelRequirement, ModelRequirementTable, DeploymentStrategy } from "../src/lib/server/lib/orchestration.mod";
import type { SchedulableModel } from "../src/lib/server/model-catalog";

const FF: DeploymentStrategy = "first-fit";

function makeNode(overrides: Partial<AiNode> & { id: string }): AiNode {
  return {
    host: "10.0.0.1",
    port: 9090,
    estCapacity: 24,
    available: true,
    driverVersions: { ollama: "0.6.3" },
    driverFeatures: {},
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
    settings: { version: 1 },
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeModel(overrides: Partial<SchedulableModel> = {}): SchedulableModel {
  return {
    specifier: "test-model",
    driver: "ollama",
    type: "chat",
    weight: 8,
    minKvCache: 2,
    minVersion: undefined,
    requiredPlatforms: [],
    requiredFeatures: [],
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
      "llama2:7b": { specifier: "llama2:7b", replicas: 1, kvCacheSize: 2, preferredDriver: null, settings: { version: 1 } },
    };
    const excess = collectExcessInstallations(requiredModels, state);
    expect(excess).toHaveLength(0);

    // Planner would place the replacement on node-a
    const replacement = findServerForModel("llama2:7b", "ollama", 8, state, [], FF);
    expect(replacement).toBe("node-a");
  });

  test("findServerForModel skips nodes missing the required driver", () => {
    const ollamaOnly = makeNode({ id: "node-c", host: "10.0.0.3" });
    const state = buildClusterState([], [ollamaOnly]);

    expect(findServerForModel("some-model", "vllm", 8, state, [], FF)).toBeNull();
  });

  test("findServerForModel skips nodes without enough capacity", () => {
    const tinyNode = makeNode({ id: "node-d", host: "10.0.0.4", estCapacity: 4 });
    const state = buildClusterState([], [tinyNode]);

    expect(findServerForModel("big-model", "ollama", 16, state, [], FF)).toBeNull();
  });

  test("findServerForModel skips nodes with incompatible driver version", () => {
    const oldNode = makeNode({ id: "node-e", host: "10.0.0.5", driverVersions: { vllm: "0.18.0" } });
    const state = buildClusterState([], [oldNode]);

    expect(findServerForModel("new-model", "vllm", 8, state, [], FF, { minVersion: "0.19.1" })).toBeNull();
  });

  test("findServerForModel accepts nodes with sufficient driver version", () => {
    const newNode = makeNode({ id: "node-f", host: "10.0.0.6", driverVersions: { vllm: "0.20.0" } });
    const state = buildClusterState([], [newNode]);

    expect(findServerForModel("new-model", "vllm", 8, state, [], FF, { minVersion: "0.19.1" })).toBe("node-f");
  });

  test("findServerForModel allows nodes whose driver version is recorded as empty (fail-open)", () => {
    const unknownNode = makeNode({ id: "node-g", host: "10.0.0.7", driverVersions: { vllm: "" } });
    const state = buildClusterState([], [unknownNode]);

    expect(findServerForModel("new-model", "vllm", 8, state, [], FF, { minVersion: "0.19.1" })).toBe("node-g");
  });

  test("findServerForModel routes past a node on a blocked release to one that is not", () => {
    const blockedVersions = [{ range: "0.27.1", reason: "crashes on the first request" }];
    const onBadRelease = makeNode({ id: "node-blocked", host: "10.0.0.20", driverVersions: { vllm: "0.27.1" } });
    const onGoodRelease = makeNode({ id: "node-ok", host: "10.0.0.21", driverVersions: { vllm: "0.27.2" } });

    expect(findServerForModel("m", "vllm", 8, buildClusterState([], [onBadRelease]), [], FF, { blockedVersions })).toBeNull();
    expect(findServerForModel("m", "vllm", 8, buildClusterState([], [onBadRelease, onGoodRelease]), [], FF, { blockedVersions })).toBe("node-ok");
  });

  test("findServerForModel skips nodes with wrong GPU platform", () => {
    const amdNode = makeNode({ id: "node-h", host: "10.0.0.8", driverVersions: { vllm: "0.20.0" }, gpus: [{ vendor: "amd", name: "MI300X", vramMb: 196608 }] });
    const state = buildClusterState([], [amdNode]);

    expect(findServerForModel("mxfp4-model", "vllm", 8, state, [], FF, { requiredPlatforms: ["nvidia"] })).toBeNull();
  });

  test("findServerForModel accepts nodes with matching GPU platform", () => {
    const nvidiaNode = makeNode({ id: "node-i", host: "10.0.0.9", driverVersions: { vllm: "0.20.0" }, gpus: [{ vendor: "nvidia", name: "A100", vramMb: 81920 }] });
    const state = buildClusterState([], [nvidiaNode]);

    expect(findServerForModel("mxfp4-model", "vllm", 8, state, [], FF, { requiredPlatforms: ["nvidia"] })).toBe("node-i");
  });

  test("findServerForModel rejects nodes with no GPUs when platform is required", () => {
    const cpuNode = makeNode({ id: "node-j", host: "10.0.0.10", driverVersions: { vllm: "0.20.0" }, gpus: [] });
    const state = buildClusterState([], [cpuNode]);

    expect(findServerForModel("mxfp4-model", "vllm", 8, state, [], FF, { requiredPlatforms: ["nvidia"] })).toBeNull();
  });

  test("findServerForModel skips nodes missing a required feature", () => {
    const node = makeNode({ id: "node-k", host: "10.0.0.11", driverVersions: { vllm: "0.20.0" }, driverFeatures: {} });
    const state = buildClusterState([], [node]);

    expect(findServerForModel("whisper", "vllm", 8, state, [], FF, { requiredFeatures: ["audio"] })).toBeNull();
  });

  test("findServerForModel accepts nodes with the required feature", () => {
    const node = makeNode({ id: "node-l", host: "10.0.0.12", driverVersions: { vllm: "0.20.0" }, driverFeatures: { vllm: ["audio"] } });
    const state = buildClusterState([], [node]);

    expect(findServerForModel("whisper", "vllm", 8, state, [], FF, { requiredFeatures: ["audio"] })).toBe("node-l");
  });

  test("findServerForModel without requiredFeatures does not filter by features", () => {
    const node = makeNode({ id: "node-m", host: "10.0.0.13", driverVersions: { vllm: "0.20.0" } });
    const state = buildClusterState([], [node]);

    expect(findServerForModel("chat-model", "vllm", 8, state, [], FF)).toBe("node-m");
  });
});

describe("orchestration: reassignable orphans", () => {
  const lookup = (models: Record<string, SchedulableModel>) => async (specifier: string) => models[specifier] ?? null;

  test("an orphan is kept (not reassigned) when no available node has room", async () => {
    const tightNode = makeNode({ id: "node-n", estCapacity: 4 });
    const state = buildClusterState([], [tightNode]);
    const orphan = makeInstallation({ id: "i1", nodeId: "node-dead", specifier: "llama2:7b", estCapacity: 8 });

    const result = await collectReassignableOrphans([orphan], state, lookup({ "llama2:7b": makeModel() }));
    expect(result).toHaveLength(0);
  });

  test("an orphan is reassigned when an available node has the driver and enough free capacity", async () => {
    const roomyNode = makeNode({ id: "node-o", estCapacity: 24 });
    const state = buildClusterState([], [roomyNode]);
    const orphan = makeInstallation({ id: "i1", nodeId: "node-dead", specifier: "llama2:7b", estCapacity: 8 });

    const result = await collectReassignableOrphans([orphan], state, lookup({ "llama2:7b": makeModel() }));
    expect(result).toEqual([orphan]);
  });

  test("an orphan is kept when no available node runs its driver, even with free capacity", async () => {
    const ollamaOnly = makeNode({ id: "node-p", estCapacity: 24, driverVersions: { ollama: "0.6.3" } });
    const state = buildClusterState([], [ollamaOnly]);
    const orphan = makeInstallation({ id: "i1", nodeId: "node-dead", specifier: "whisper", driver: "vllm", estCapacity: 8 });

    const result = await collectReassignableOrphans([orphan], state, lookup({ whisper: makeModel({ specifier: "whisper", driver: "vllm" }) }));
    expect(result).toHaveLength(0);
  });

  test("an orphan is kept when the only available node is already full from active installations", async () => {
    const node = makeNode({ id: "node-q", estCapacity: 8 });
    const active = makeInstallation({ id: "active-1", nodeId: "node-q", specifier: "other-model", estCapacity: 8 });
    const state = buildClusterState([active], [node]);
    const orphan = makeInstallation({ id: "i1", nodeId: "node-dead", specifier: "llama2:7b", estCapacity: 8 });

    const result = await collectReassignableOrphans([orphan], state, lookup({ "llama2:7b": makeModel() }));
    expect(result).toHaveLength(0);
  });

  test("an orphan is kept when the only available node's driver version is too old for the model", async () => {
    const oldNode = makeNode({ id: "node-r", estCapacity: 24, driverVersions: { vllm: "0.18.0" } });
    const state = buildClusterState([], [oldNode]);
    const orphan = makeInstallation({ id: "i1", nodeId: "node-dead", specifier: "new-model", driver: "vllm", estCapacity: 8 });
    const model = makeModel({ specifier: "new-model", driver: "vllm", minVersion: "0.19.1" });

    // This is the case a plain driver+capacity check would wrongly approve for deletion: the
    // node has the right driver and plenty of room, but its vLLM build is too old to run this
    // model, so there is no real reassignment target.
    const result = await collectReassignableOrphans([orphan], state, lookup({ "new-model": model }));
    expect(result).toHaveLength(0);
  });

  test("an orphan is kept when the model can't be looked up in the catalog", async () => {
    const roomyNode = makeNode({ id: "node-s", estCapacity: 24 });
    const state = buildClusterState([], [roomyNode]);
    const orphan = makeInstallation({ id: "i1", nodeId: "node-dead", specifier: "removed-model", estCapacity: 8 });

    const result = await collectReassignableOrphans([orphan], state, lookup({}));
    expect(result).toHaveLength(0);
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

describe("orchestration: settings drift", () => {
  function requirement(overrides: Partial<ModelRequirement> = {}): ModelRequirement {
    return { specifier: "whisper", replicas: 1, kvCacheSize: null, preferredDriver: null, settings: { version: 1 }, ...overrides };
  }

  test("installation with drifted settings is collected and released from state", () => {
    const node = makeNode({ id: "node-1" });
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "whisper", settings: { version: 1, maxAudioInputDurationS: 600 } });
    const state = buildClusterState([inst], [node]);
    const required: ModelRequirementTable = {
      whisper: requirement({ settings: { version: 1, maxAudioInputDurationS: 1200 } }),
    };

    const drifted = collectDriftedInstallations(required, state);

    expect(drifted).toEqual(["i1"]);
    expect(state.installationsByModel.get("whisper")).toHaveLength(0);
    expect(state.serverCapacity.get("node-1")!.used).toBe(0);
    expect(findServerForModel("whisper", "ollama", 8, state, [], FF)).toBe("node-1");
  });

  test("matching settings produce no drift", () => {
    const node = makeNode({ id: "node-1" });
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "whisper", settings: { version: 1, maxAudioInputDurationS: 1200 } });
    const state = buildClusterState([inst], [node]);
    const required: ModelRequirementTable = {
      whisper: requirement({ settings: { version: 1, maxAudioInputDurationS: 1200 } }),
    };

    expect(collectDriftedInstallations(required, state)).toHaveLength(0);
    expect(state.installationsByModel.get("whisper")).toHaveLength(1);
    expect(state.serverCapacity.get("node-1")!.used).toBe(8);
  });

  test("legacy default snapshot equals freshly computed default settings", () => {
    const node = makeNode({ id: "node-1" });
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "whisper" });
    const state = buildClusterState([inst], [node]);

    expect(collectDriftedInstallations({ whisper: requirement() }, state)).toHaveLength(0);
  });

  test("installations without a requirement are left to excess trimming", () => {
    const node = makeNode({ id: "node-1" });
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "whisper", settings: { version: 1, maxAudioInputDurationS: 600 } });
    const state = buildClusterState([inst], [node]);

    expect(collectDriftedInstallations({}, state)).toHaveLength(0);
    expect(state.installationsByModel.get("whisper")).toHaveLength(1);
  });

  test("only the drifted replica of a pair is collected", () => {
    const node = makeNode({ id: "node-1", estCapacity: 48 });
    const current = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "whisper", settings: { version: 1, maxAudioInputDurationS: 1200 } });
    const stale = makeInstallation({ id: "i2", nodeId: "node-1", specifier: "whisper" });
    const state = buildClusterState([current, stale], [node]);
    const required: ModelRequirementTable = {
      whisper: requirement({ replicas: 2, settings: { version: 1, maxAudioInputDurationS: 1200 } }),
    };

    expect(collectDriftedInstallations(required, state)).toEqual(["i2"]);
    expect(state.installationsByModel.get("whisper")!.map(i => i.id)).toEqual(["i1"]);
  });
});

describe("orchestration: requirement merging", () => {
  test("settings merge takes the maximum audio duration across deployments", () => {
    const merged = mergeRequirementsBySpecifier([
      { specifier: "whisper", replicas: 1, kvCacheSize: null, preferredDriver: null, settings: { version: 1, maxAudioInputDurationS: 600 } },
      { specifier: "whisper", replicas: 2, kvCacheSize: 4, preferredDriver: null, settings: { version: 1, maxAudioInputDurationS: 1800 } },
      { specifier: "whisper", replicas: 1, kvCacheSize: null, preferredDriver: null, settings: { version: 1 } },
    ]);

    expect(merged.whisper.replicas).toBe(2);
    expect(merged.whisper.kvCacheSize).toBe(4);
    expect(merged.whisper.settings).toEqual({ version: 1, maxAudioInputDurationS: 1800 });
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
