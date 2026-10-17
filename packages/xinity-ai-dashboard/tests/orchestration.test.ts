import { describe, test, expect } from "bun:test";
import { chargeUnchargedInstallations, collectDriftedInstallations, collectExcessInstallations, collectIncompleteGroups, collectReassignableOrphans, collectReplicasThatDoNotFit, findPlacement, findServerForModel } from "../src/lib/server/lib/deployments/orchestration";
import { buildClusterState, rankServers, resourcesOf } from "../src/lib/server/lib/deployments/cluster-state";
import { layoutForVllm, vllmScheduler } from "../src/lib/server/lib/deployments/engines/vllm";
import { requirementsForDeployments, type ModelRequirement, type ModelRequirementTable } from "../src/lib/server/lib/deployments/requirements";
import type { DeploymentStrategy } from "../src/lib/server/lib/deployments/strategy";
import type { AiNode, ModelDeployment, ModelInstallation } from "common-db";
import type { SchedulableModel } from "../src/lib/server/lib/models/model-catalog";
import { GROUP_MEMBER_FEATURE, type FootprintEntry } from "common-env";

const FF: DeploymentStrategy = "first-fit";
const need = (weight: number) => ({ model: { weight }, kvCacheGb: 0, goal: "space" as const });

function makeNode(overrides: Partial<AiNode> & { id: string }): AiNode {
  return {
    host: "10.0.0.1",
    port: 9090,
    estCapacity: 24,
    hostMemoryGb: null,
    available: true,
    driverVersions: { ollama: "0.6.3" },
    driverFeatures: {},
    gpus: [],
    interconnect: [],
    gpuCount: 1,
    machineName: null,
    authToken: null,
    publicKey: null,
    tls: false,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeInstallation(overrides: Partial<ModelInstallation> & { id: string; nodeId: string; specifier: string }): ModelInstallation {
  return {
    deploymentId: "dep-1",
    estCapacity: 8,
    kvCacheCapacity: 2,
    hostCapacity: 0,
    maxNumSeqs: null,
    port: 11434,
    driver: "ollama",
    settings: { version: 1 },
    gpuIds: [],
    group: null,
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
    // node-b just went offline, so syncDeployedModels filters it out of availableServers
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
    expect(state.installationsByRequirement.has("dep-1:llama2:7b")).toBe(false);

    // No excess to trim (nothing active)
    const requiredModels: ModelRequirementTable = {
      "dep-1:llama2:7b": { deploymentId: "dep-1", specifier: "llama2:7b", replicas: 1, kvCacheSize: 2, preferredDriver: null, settings: { version: 1 } },
    };
    const excess = collectExcessInstallations(requiredModels, state);
    expect(excess).toHaveLength(0);

    // Planner would place the replacement on node-a
    const replacement = findServerForModel({ deploymentId: "dep-1", specifier: "llama2:7b" }, "ollama", need(8), state, [], FF);
    expect(replacement).toBe("node-a");
  });

  test("findServerForModel skips nodes missing the required driver", () => {
    const ollamaOnly = makeNode({ id: "node-c", host: "10.0.0.3" });
    const state = buildClusterState([], [ollamaOnly]);

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "some-model" }, "vllm", need(8), state, [], FF)).toBeNull();
  });

  test("findServerForModel skips nodes without enough capacity", () => {
    const tinyNode = makeNode({ id: "node-d", host: "10.0.0.4", estCapacity: 4 });
    const state = buildClusterState([], [tinyNode]);

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "big-model" }, "ollama", need(16), state, [], FF)).toBeNull();
  });

  test("findServerForModel skips nodes with incompatible driver version", () => {
    const oldNode = makeNode({ id: "node-e", host: "10.0.0.5", driverVersions: { vllm: "0.18.0" } });
    const state = buildClusterState([], [oldNode]);

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "new-model" }, "vllm", need(8), state, [], FF, { minVersion: "0.19.1" })).toBeNull();
  });

  test("findServerForModel accepts nodes with sufficient driver version", () => {
    const newNode = makeNode({ id: "node-f", host: "10.0.0.6", driverVersions: { vllm: "0.20.0" } });
    const state = buildClusterState([], [newNode]);

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "new-model" }, "vllm", need(8), state, [], FF, { minVersion: "0.19.1" })).toBe("node-f");
  });

  test("findServerForModel allows nodes whose driver version is recorded as empty (fail-open)", () => {
    const unknownNode = makeNode({ id: "node-g", host: "10.0.0.7", driverVersions: { vllm: "" } });
    const state = buildClusterState([], [unknownNode]);

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "new-model" }, "vllm", need(8), state, [], FF, { minVersion: "0.19.1" })).toBe("node-g");
  });

  test("findServerForModel routes past a node on a blocked release to one that is not", () => {
    const blockedVersions = [{ range: "0.27.1", reason: "crashes on the first request" }];
    const onBadRelease = makeNode({ id: "node-blocked", host: "10.0.0.20", driverVersions: { vllm: "0.27.1" } });
    const onGoodRelease = makeNode({ id: "node-ok", host: "10.0.0.21", driverVersions: { vllm: "0.27.2" } });

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "m" }, "vllm", need(8), buildClusterState([], [onBadRelease]), [], FF, { blockedVersions })).toBeNull();
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "m" }, "vllm", need(8), buildClusterState([], [onBadRelease, onGoodRelease]), [], FF, { blockedVersions })).toBe("node-ok");
  });

  test("findServerForModel skips nodes with wrong GPU platform", () => {
    const amdNode = makeNode({ id: "node-h", host: "10.0.0.8", driverVersions: { vllm: "0.20.0" }, gpus: [{ vendor: "amd", name: "MI300X", vramMb: 196608 }] });
    const state = buildClusterState([], [amdNode]);

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "mxfp4-model" }, "vllm", need(8), state, [], FF, { requiredPlatforms: ["nvidia"] })).toBeNull();
  });

  test("findServerForModel accepts nodes with matching GPU platform", () => {
    const nvidiaNode = makeNode({ id: "node-i", host: "10.0.0.9", driverVersions: { vllm: "0.20.0" }, gpus: [{ vendor: "nvidia", name: "A100", vramMb: 81920 }] });
    const state = buildClusterState([], [nvidiaNode]);

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "mxfp4-model" }, "vllm", need(8), state, [], FF, { requiredPlatforms: ["nvidia"] })).toBe("node-i");
  });

  test("findServerForModel rejects nodes with no GPUs when platform is required", () => {
    const cpuNode = makeNode({ id: "node-j", host: "10.0.0.10", driverVersions: { vllm: "0.20.0" }, gpus: [] });
    const state = buildClusterState([], [cpuNode]);

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "mxfp4-model" }, "vllm", need(8), state, [], FF, { requiredPlatforms: ["nvidia"] })).toBeNull();
  });

  test("findServerForModel skips nodes missing a required feature", () => {
    const node = makeNode({ id: "node-k", host: "10.0.0.11", driverVersions: { vllm: "0.20.0" }, driverFeatures: {} });
    const state = buildClusterState([], [node]);

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "whisper" }, "vllm", need(8), state, [], FF, { requiredFeatures: ["audio"] })).toBeNull();
  });

  test("findServerForModel accepts nodes with the required feature", () => {
    const node = makeNode({ id: "node-l", host: "10.0.0.12", driverVersions: { vllm: "0.20.0" }, driverFeatures: { vllm: ["audio"] } });
    const state = buildClusterState([], [node]);

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "whisper" }, "vllm", need(8), state, [], FF, { requiredFeatures: ["audio"] })).toBe("node-l");
  });

  test("findServerForModel without requiredFeatures does not filter by features", () => {
    const node = makeNode({ id: "node-m", host: "10.0.0.13", driverVersions: { vllm: "0.20.0" } });
    const state = buildClusterState([], [node]);

    expect(findServerForModel({ deploymentId: "dep-1", specifier: "chat-model" }, "vllm", need(8), state, [], FF)).toBe("node-m");
  });
});

describe("orchestration: vllm runs on the first card", () => {
  const card = (vramMb: number) => ({ vendor: "nvidia", name: "card", vramMb });
  const twoCards = makeNode({
    id: "node-2x24", estCapacity: 48, gpuCount: 2,
    gpus: [card(24576), card(24576)], driverVersions: { vllm: "0.30.0", ollama: "0.6.3" },
  });
  const vllmOnFirstCard = makeInstallation({ id: "inst-v", nodeId: "node-2x24", specifier: "a-vllm", driver: "vllm", estCapacity: 20 });

  test("refuses a vllm installation the first card cannot hold, though the node's sum could", () => {
    const state = buildClusterState([vllmOnFirstCard], [twoCards]);
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "b-vllm" }, "vllm", need(8), state, [], FF)).toBeNull();
  });

  test("still places ollama against the node's whole capacity", () => {
    const state = buildClusterState([vllmOnFirstCard], [twoCards]);
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "b-ollama" }, "ollama", need(8), state, [], FF)).toBe("node-2x24");
  });

  test("does not count ollama against the card vllm runs on", () => {
    const ollama = makeInstallation({ id: "inst-o", nodeId: "node-2x24", specifier: "o", driver: "ollama", estCapacity: 20 });
    const state = buildClusterState([ollama], [twoCards]);
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "b-vllm" }, "vllm", need(20), state, [], FF)).toBe("node-2x24");
  });

  test("treats a unified-memory node as one card of its whole capacity", () => {
    const gb10 = makeNode({ id: "node-gb10", estCapacity: 109, gpus: [card(0)], driverVersions: { vllm: "0.30.0" } });
    const state = buildClusterState([], [gb10]);
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "big-vllm" }, "vllm", need(60), state, [], FF)).toBe("node-gb10");
  });
});

describe("orchestration: vllm pinned to cards", () => {
  const card = (uuid: string) => ({ vendor: "nvidia", name: "card", vramMb: 24576, uuid });
  const node = makeNode({
    id: "node-ab", estCapacity: 48, gpuCount: 2,
    gpus: [card("GPU-A"), card("GPU-B")], driverVersions: { vllm: "0.30.0" },
  });
  const vllm = (id: string, estCapacity: number, gpuIds: string[]) =>
    makeInstallation({ id, nodeId: "node-ab", specifier: id, driver: "vllm", estCapacity, gpuIds });

  test("pins to the card that still has room", () => {
    const state = buildClusterState([vllm("a", 20, ["GPU-A"])], [node]);
    expect(layoutForVllm(resourcesOf(state, "node-ab"), { weight: 8 }, 0, "space", FF)?.cards[0]?.id).toBe("GPU-B");
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "b" }, "vllm", need(8), state, [], FF)).toBe("node-ab");
  });

  test("counts an unpinned installation against the first card, where the daemon runs it", () => {
    const state = buildClusterState([vllm("a", 20, [])], [node]);
    expect(layoutForVllm(resourcesOf(state, "node-ab"), { weight: 8 }, 0, "space", FF)?.cards[0]?.id).toBe("GPU-B");
  });

  test("chooses between cards with the same strategy as between nodes", () => {
    const state = buildClusterState([vllm("a", 10, ["GPU-A"])], [node]);
    expect(layoutForVllm(resourcesOf(state, "node-ab"), { weight: 8 }, 0, "space", "bin-pack")?.cards[0]?.id).toBe("GPU-A");
    expect(layoutForVllm(resourcesOf(state, "node-ab"), { weight: 8 }, 0, "space", "balanced")?.cards[0]?.id).toBe("GPU-B");
  });

  test("refuses the node once no single card can hold the installation", () => {
    const state = buildClusterState([vllm("a", 20, ["GPU-A"]), vllm("b", 20, ["GPU-B"])], [node]);
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "c" }, "vllm", need(8), state, [], FF)).toBeNull();
  });

  test("leaves the installation unpinned on a node whose cards report no id", () => {
    const legacy = makeNode({ id: "node-old", gpus: [{ vendor: "nvidia", name: "card", vramMb: 24576 }], driverVersions: { vllm: "0.30.0" } });
    const state = buildClusterState([], [legacy]);
    expect(layoutForVllm(resourcesOf(state, "node-old"), { weight: 8 }, 0, "space", FF)?.cards[0]?.id).toBeNull();
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

describe("orchestration: installation indexing", () => {
  const node = makeNode({ id: "node-1" });

  test("installation indexes under its deployment and model", () => {
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "llama-3.3-70b" });
    const state = buildClusterState([inst], [node]);
    expect(state.installationsByRequirement.has("dep-1:llama-3.3-70b")).toBe(true);
  });

  test("findServerForModel skips a node that already hosts the specifier", () => {
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "llama-3.3-70b" });
    const state = buildClusterState([inst], [node]);
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "llama-3.3-70b" }, "ollama", need(8), state, [], FF)).toBeNull();
  });
});

describe("orchestration: vllm layouts", () => {
  const card = (uuid: string, name: string, vramMb: number) => ({ vendor: "nvidia", name, vramMb, uuid });
  const node = makeNode({
    id: "node-mixed", estCapacity: 138, gpuCount: 3, driverVersions: { vllm: "0.30.0" },
    gpus: [card("L-1", "L40S", 46080), card("L-2", "L40S", 46080), card("A-1", "A6000", 49152)],
  });
  const qwen = { weight: 26, attentionHeads: 24, kvHeads: 4 };
  const ids = (layout: { cards: { id: string | null }[] } | undefined) => layout?.cards.map((c) => c.id);

  test("space keeps a model on one card when it fits", () => {
    const state = buildClusterState([], [node]);
    expect(ids(layoutForVllm(resourcesOf(state, "node-mixed"), qwen, 16, "space", FF))).toEqual(["L-1"]);
  });

  test("speed splits across identical cards and never mixes card models", () => {
    const state = buildClusterState([], [node]);
    const layout = layoutForVllm(resourcesOf(state, "node-mixed"), qwen, 16, "speed", FF);
    expect(ids(layout)).toEqual(["L-1", "L-2"]);
    expect(layout!.perCardGb).toBe(21);
  });

  test("splits a model no single card can hold, even for space", () => {
    const state = buildClusterState([], [node]);
    expect(ids(layoutForVllm(resourcesOf(state, "node-mixed"), { ...qwen, weight: 60 }, 16, "space", FF))).toEqual(["L-1", "L-2"]);
  });

  test("cannot split a model whose head counts are not stated", () => {
    const state = buildClusterState([], [node]);
    expect(layoutForVllm(resourcesOf(state, "node-mixed"), { weight: 60 }, 16, "space", FF)).toBeUndefined();
  });

  test("falls back to fewer cards when an identical card is too full to take its share", () => {
    const busy = makeInstallation({ id: "i1", nodeId: "node-mixed", specifier: "other", driver: "vllm", estCapacity: 30, gpuIds: ["L-1"] });
    const state = buildClusterState([busy], [node]);
    expect(ids(layoutForVllm(resourcesOf(state, "node-mixed"), qwen, 16, "speed", FF))).toEqual(["L-2"]);
  });

  test("lands on the first card unpinned when no card reports an id", () => {
    const legacy = makeNode({ id: "node-old", gpus: [{ vendor: "nvidia", name: "card", vramMb: 49152 }], driverVersions: { vllm: "0.30.0" } });
    const state = buildClusterState([], [legacy]);
    expect(ids(layoutForVllm(resourcesOf(state, "node-old"), qwen, 16, "speed", FF))).toEqual([null]);
  });

  test("never splits across intel cards, and pins them by bus id", () => {
    const arc = (pciBusId: string) => ({ vendor: "intel", name: "Intel(R) Arc(TM) A770 Graphics", vramMb: 16384, pciBusId });
    const intel = makeNode({ id: "node-arc", gpus: [arc("0000:03:00.0"), arc("0000:04:00.0")], driverVersions: { vllm: "0.30.0" } });
    const state = buildClusterState([], [intel]);
    expect(ids(layoutForVllm(resourcesOf(state, "node-arc"), { weight: 8, attentionHeads: 32, kvHeads: 8 }, 4, "speed", FF))).toEqual(["0000:03:00.0"]);
    expect(layoutForVllm(resourcesOf(state, "node-arc"), { weight: 20, attentionHeads: 32, kvHeads: 8 }, 4, "space", FF)).toBeUndefined();
  });
});

describe("orchestration: placing across cards", () => {
  const l40s = (uuid: string) => ({ vendor: "nvidia", name: "L40S", vramMb: 46080, uuid });
  const twoCards = makeNode({ id: "node-2", estCapacity: 90, gpuCount: 2, gpus: [l40s("L-1"), l40s("L-2")], driverVersions: { vllm: "0.30.0" } });
  const qwen = { weight: 26, attentionHeads: 24, kvHeads: 4 };

  test("a split installation occupies its per-card need on every card", () => {
    const slot = vllmScheduler.placeOnNode(resourcesOf(buildClusterState([], [twoCards]), "node-2"), { model: qwen, kvCacheGb: 16, goal: "speed", strategy: FF });
    expect(slot).toEqual({ gpuIds: ["L-1", "L-2"], estCapacity: 42, hostCapacity: 0, maxNumSeqs: null });
  });

  test("counts the kv cache every card holds once the kv heads are replicated", () => {
    const eight = makeNode({ id: "node-8", estCapacity: 360, gpuCount: 8, gpus: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => l40s(`L-${n}`)), driverVersions: { vllm: "0.30.0" } });
    const slot = vllmScheduler.placeOnNode(resourcesOf(buildClusterState([], [eight]), "node-8"), { model: qwen, kvCacheGb: 16, goal: "speed", strategy: FF });
    expect(slot!.gpuIds).toHaveLength(8);
    expect(slot!.estCapacity).toBe(58);
  });

  test("places a model no single card holds on a node whose identical cards can split it", () => {
    const state = buildClusterState([], [twoCards]);
    const big = { model: { ...qwen, weight: 60 }, kvCacheGb: 16, goal: "space" as const };
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "big" }, "vllm", big, state, [], FF)).toBe("node-2");
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "big" }, "vllm", { ...big, model: { weight: 60 } }, state, [], FF)).toBeNull();
  });
});

describe("orchestration: node rule per engine", () => {
  const card = (uuid: string) => ({ vendor: "nvidia", name: "card", vramMb: 24576, uuid });
  const node = makeNode({
    id: "node-ab", estCapacity: 48, gpuCount: 2,
    gpus: [card("GPU-A"), card("GPU-B")], driverVersions: { vllm: "0.30.0", ollama: "0.6.3" },
  });

  test("keeps a second deployment's installation of one ollama tag off the node", () => {
    const inst = makeInstallation({ id: "i1", nodeId: "node-ab", deploymentId: "dep-1", specifier: "llama", driver: "ollama" });
    const state = buildClusterState([inst], [node]);
    expect(findServerForModel({ deploymentId: "dep-2", specifier: "llama" }, "ollama", need(8), state, [], FF)).toBeNull();
  });

  test("lets a second deployment's vllm installation of one model share the node", () => {
    const inst = makeInstallation({ id: "i1", nodeId: "node-ab", deploymentId: "dep-1", specifier: "qwen", driver: "vllm", gpuIds: ["GPU-A"] });
    const state = buildClusterState([inst], [node]);
    expect(findServerForModel({ deploymentId: "dep-2", specifier: "qwen" }, "vllm", need(8), state, [], FF)).toBe("node-ab");
  });

  test("still spreads the vllm replicas of one deployment across nodes", () => {
    const inst = makeInstallation({ id: "i1", nodeId: "node-ab", deploymentId: "dep-1", specifier: "qwen", driver: "vllm", gpuIds: ["GPU-A"] });
    const state = buildClusterState([inst], [node]);
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "qwen" }, "vllm", need(8), state, [], FF)).toBeNull();
  });
});

describe("orchestration: settings drift", () => {
  function requirement(overrides: Partial<ModelRequirement> = {}): ModelRequirement {
    return { deploymentId: "dep-1", specifier: "whisper", replicas: 1, kvCacheSize: null, preferredDriver: null, settings: { version: 1 }, ...overrides };
  }

  test("installation with drifted settings is collected and released from state", () => {
    const node = makeNode({ id: "node-1" });
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "whisper", settings: { version: 1, maxAudioInputDurationS: 600 } });
    const state = buildClusterState([inst], [node]);
    const required: ModelRequirementTable = {
      "dep-1:whisper": requirement({ settings: { version: 1, maxAudioInputDurationS: 1200 } }),
    };

    const drifted = collectDriftedInstallations(required, state);

    expect(drifted).toEqual(["i1"]);
    expect(state.installationsByRequirement.get("dep-1:whisper")).toHaveLength(0);
    expect(state.serverCapacity.get("node-1")!.used).toBe(0);
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "whisper" }, "ollama", need(8), state, [], FF)).toBe("node-1");
  });

  test("matching settings produce no drift", () => {
    const node = makeNode({ id: "node-1" });
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "whisper", settings: { version: 1, maxAudioInputDurationS: 1200 } });
    const state = buildClusterState([inst], [node]);
    const required: ModelRequirementTable = {
      "dep-1:whisper": requirement({ settings: { version: 1, maxAudioInputDurationS: 1200 } }),
    };

    expect(collectDriftedInstallations(required, state)).toHaveLength(0);
    expect(state.installationsByRequirement.get("dep-1:whisper")).toHaveLength(1);
    expect(state.serverCapacity.get("node-1")!.used).toBe(8);
  });

  test("legacy default snapshot equals freshly computed default settings", () => {
    const node = makeNode({ id: "node-1" });
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "whisper" });
    const state = buildClusterState([inst], [node]);

    expect(collectDriftedInstallations({ "dep-1:whisper": requirement() }, state)).toHaveLength(0);
  });

  test("installations without a requirement are left to excess trimming", () => {
    const node = makeNode({ id: "node-1" });
    const inst = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "whisper", settings: { version: 1, maxAudioInputDurationS: 600 } });
    const state = buildClusterState([inst], [node]);

    expect(collectDriftedInstallations({}, state)).toHaveLength(0);
    expect(state.installationsByRequirement.get("dep-1:whisper")).toHaveLength(1);
  });

  test("only the drifted replica of a pair is collected", () => {
    const node = makeNode({ id: "node-1", estCapacity: 48 });
    const current = makeInstallation({ id: "i1", nodeId: "node-1", specifier: "whisper", settings: { version: 1, maxAudioInputDurationS: 1200 } });
    const stale = makeInstallation({ id: "i2", nodeId: "node-1", specifier: "whisper" });
    const state = buildClusterState([current, stale], [node]);
    const required: ModelRequirementTable = {
      "dep-1:whisper": requirement({ replicas: 2, settings: { version: 1, maxAudioInputDurationS: 1200 } }),
    };

    expect(collectDriftedInstallations(required, state)).toEqual(["i2"]);
    expect(state.installationsByRequirement.get("dep-1:whisper")!.map(i => i.id)).toEqual(["i1"]);
  });
});

describe("orchestration: requirements per deployment", () => {
  function makeDeployment(overrides: Partial<ModelDeployment> & { id: string; specifier: string }): ModelDeployment {
    return {
      organizationId: "org-1",
      name: overrides.id,
      description: null,
      enabled: true,
      publicSpecifier: overrides.id,
      earlySpecifier: null,
      replicas: 1,
      canaryProgressUntil: null,
      canaryProgressFrom: null,
      canaryProgressWithFeedback: false,
      progress: 100,
      kvCacheSize: null,
      earlyKvCacheSize: null,
      preferredDriver: null,
      settings: { version: 1 },
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  test("keeps two deployments of one model apart, each with its own replicas and settings", () => {
    const table = requirementsForDeployments([
      makeDeployment({ id: "dep-a", specifier: "whisper", replicas: 1, settings: { version: 1, maxAudioInputDurationS: 600 } }),
      makeDeployment({ id: "dep-b", specifier: "whisper", replicas: 2 }),
    ]);

    expect(Object.keys(table).sort()).toEqual(["dep-a:whisper", "dep-b:whisper"]);
    expect(table["dep-a:whisper"]!.settings).toEqual({ version: 1, maxAudioInputDurationS: 600 });
    expect(table["dep-b:whisper"]!.replicas).toBe(2);
  });

  test("splits a canary deployment into its primary and early side", () => {
    const table = requirementsForDeployments([
      makeDeployment({ id: "dep-a", specifier: "old", earlySpecifier: "new", progress: 25, replicas: 4 }),
    ]);

    expect(table["dep-a:old"]!.replicas).toBe(1);
    expect(table["dep-a:new"]!.replicas).toBe(3);
  });

  test("treats a canary onto the same model as one requirement with every replica", () => {
    const table = requirementsForDeployments([
      makeDeployment({ id: "dep-a", specifier: "same", earlySpecifier: "same", progress: 25, replicas: 4 }),
    ]);

    expect(Object.keys(table)).toEqual(["dep-a:same"]);
    expect(table["dep-a:same"]!.replicas).toBe(4);
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
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "new-model" }, "ollama", need(4), state, [], "balanced")).toBe("node-c");
  });

  test("findServerForModel bin-pack picks tightest fit that still satisfies", () => {
    const state = buildClusterState(preinstalls, [nodeA, nodeB, nodeC]);
    // B has 8 free, the tightest that fits a 4GB model.
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "new-model" }, "ollama", need(4), state, [], "bin-pack")).toBe("node-b");
  });

  test("findServerForModel bin-pack skips nodes too tight to fit", () => {
    const state = buildClusterState(preinstalls, [nodeA, nodeB, nodeC]);
    // 10GB doesn't fit on B (8 free), so falls through to A (20 free), not C (24 free).
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "big-model" }, "ollama", need(10), state, [], "bin-pack")).toBe("node-a");
  });

  test("findServerForModel proportional picks lowest percent used", () => {
    const state = buildClusterState(preinstalls, [nodeA, nodeB, nodeC]);
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "new-model" }, "ollama", need(4), state, [], "proportional")).toBe("node-a");
  });

  test("balanced spreads replicas across nodes across consecutive placements", () => {
    // No preinstalls. Three equal-size nodes. Placing 3 replicas of a 4GB model with
    // balanced should land one on each, because the planner mutates serverCapacity
    // between placements and rankServers re-sorts each call.
    const empty = buildClusterState([], [nodeA, nodeB, nodeC]);
    const pending: Parameters<typeof findServerForModel>[4] = [];

    const first = findServerForModel({ deploymentId: "dep-1", specifier: "m" }, "ollama", need(4), empty, pending, "balanced")!;
    empty.serverCapacity.get(first)!.used += 4;
    pending.push({ nodeId: first, deploymentId: "dep-1", specifier: "m", estCapacity: 4, kvCacheCapacity: 0, driver: "ollama", port: 11434 });

    const second = findServerForModel({ deploymentId: "dep-1", specifier: "m" }, "ollama", need(4), empty, pending, "balanced")!;
    empty.serverCapacity.get(second)!.used += 4;
    pending.push({ nodeId: second, deploymentId: "dep-1", specifier: "m", estCapacity: 4, kvCacheCapacity: 0, driver: "ollama", port: 11434 });

    const third = findServerForModel({ deploymentId: "dep-1", specifier: "m" }, "ollama", need(4), empty, pending, "balanced")!;

    expect(new Set([first, second, third])).toEqual(new Set(["node-a", "node-b", "node-c"]));
  });
});

describe("orchestration: charging footprints", () => {
  const GIB = 1.073741824;
  const l40s = (uuid: string) => ({ vendor: "nvidia", name: "L40S", vramMb: 46080, uuid });
  const discrete = (hostMemoryGb: number | null) => makeNode({
    id: "node-l40s", estCapacity: 90, gpuCount: 2, gpus: [l40s("L-1"), l40s("L-2")], driverVersions: { vllm: "0.31.0" }, hostMemoryGb,
  });
  const entry = (limits: FootprintEntry["placement"]["limits"] = []) => ({
    weight: 26, attentionHeads: 24, kvHeads: 4,
    footprint: { sizing: { weightGb: 26, minKvCacheGb: 4, maxContextLength: 32768, attentionHeads: 24, kvHeads: 4 }, tags: [], placement: { limits } },
  });
  const request = (goal: "space" | "speed", model = entry()) => ({ model, kvCacheGb: 4, goal, strategy: FF });

  test("charges every card the engine's own memory on top of its weights and kv, and the node its host processes", () => {
    const node = resourcesOf(buildClusterState([], [discrete(null)]), "node-l40s");
    const whole = vllmScheduler.placeOnNode(node, request("space"))!;
    expect(whole.estCapacity).toBeCloseTo(26 + 4 + 2.5 * GIB);
    expect(whole.hostCapacity).toBeCloseTo(5.5 * GIB);
    const split = vllmScheduler.placeOnNode(node, request("speed"))!;
    expect(split.gpuIds).toEqual(["L-1", "L-2"]);
    expect(split.estCapacity).toBeCloseTo(2 * (13 + 2 + 3.5 * GIB));
    expect(split.hostCapacity).toBeCloseTo((5.5 + 6) * GIB);
  });

  test("refuses a discrete node whose reported host memory cannot take the host part, and leaves an unreported one unlimited", () => {
    const placement = { deploymentId: "dep-1", specifier: "qwen" };
    expect(findServerForModel(placement, "vllm", request("space"), buildClusterState([], [discrete(4)]), [], FF)).toBeNull();
    expect(findServerForModel(placement, "vllm", request("space"), buildClusterState([], [discrete(null)]), [], FF)).toBe("node-l40s");
  });

  test("counts host memory already charged on the node", () => {
    const placed = makeInstallation({ id: "i1", nodeId: "node-l40s", specifier: "other", driver: "vllm", estCapacity: 10, hostCapacity: 60, gpuIds: ["L-1"] });
    const state = buildClusterState([placed], [discrete(64)]);
    expect(findServerForModel({ deploymentId: "dep-1", specifier: "qwen" }, "vllm", request("space"), state, [], FF)).toBeNull();
  });

  test("charges a unified-memory node's one pool for both parts", () => {
    const gb10 = makeNode({ id: "node-gb10", estCapacity: 109, gpus: [{ vendor: "nvidia", name: "GB10", vramMb: 0 }], driverVersions: { vllm: "0.31.0" }, hostMemoryGb: 115 });
    const model = (weight: number) => ({ ...entry(), weight, footprint: { ...entry().footprint, sizing: { ...entry().footprint.sizing, weightGb: weight } } });
    const placement = { deploymentId: "dep-1", specifier: "big" };
    expect(findServerForModel(placement, "vllm", request("space", model(100)), buildClusterState([], [gb10]), [], FF)).toBeNull();
    const state = buildClusterState([], [gb10]);
    const slot = vllmScheduler.placeOnNode(resourcesOf(state, "node-gb10"), request("space", model(95)))!;
    expect(slot.estCapacity + slot.hostCapacity).toBeLessThanOrEqual(109);
    expect(findServerForModel(placement, "vllm", request("space", model(95)), state, [], FF)).toBe("node-gb10");
  });

  test("decides how many sequences the engine runs, from the entry's own setting when it has one", () => {
    const node = resourcesOf(buildClusterState([], [discrete(null)]), "node-l40s");
    const capped = { ...entry(), footprint: { ...entry().footprint, engineArgs: ["--max-num-seqs", "64"] } };
    expect(vllmScheduler.placeOnNode(node, request("space", capped))!.maxNumSeqs).toBe(64);
  });

  test("keeps an installation on the splits its entry allows", () => {
    const node = resourcesOf(buildClusterState([], [discrete(null)]), "node-l40s");
    const oneCardOnly = entry([{ limit: "splitSizes", values: [1], reason: "FP8 blocks" }]);
    expect(vllmScheduler.placeOnNode(node, request("speed", oneCardOnly))!.gpuIds).toEqual(["L-1"]);
  });

  test("charges a row placed before host memory was charged once, for the cards it runs on", async () => {
    const uncharged = makeInstallation({ id: "old", nodeId: "node-l40s", specifier: "qwen", driver: "vllm", estCapacity: 30, kvCacheCapacity: 4, hostCapacity: null, gpuIds: ["L-1", "L-2"] });
    const charged = makeInstallation({ id: "new", nodeId: "node-l40s", specifier: "qwen", driver: "vllm", estCapacity: 33, hostCapacity: 5 });
    const lookup = async () => makeModel({ ...entry(), driver: "vllm" });
    const [old, kept] = await chargeUnchargedInstallations([uncharged, charged], [discrete(null)], lookup);
    expect(old!.estCapacity).toBeCloseTo(2 * (13 + 2 + 3.5 * GIB));
    expect(old!.hostCapacity).toBeCloseTo((5.5 + 6) * GIB);
    expect(kept).toBe(charged);
    const [unknown] = await chargeUnchargedInstallations([uncharged], [discrete(null)], async () => null);
    expect(unknown).toBe(uncharged);
  });
});

describe("orchestration: serving across coupled nodes", () => {
  const GIB = 1.073741824;
  const placement = { deploymentId: "dep-1", specifier: "big" };
  const path = (mac: string, ipv4: string) => ({
    interface: `if-${mac}`, mac, carrier: true, mtu: 9000, speedMbps: 200000, linkLayer: "Ethernet",
    ipv4: [ipv4], roceV2Ipv4: [ipv4.split("/")[0]!], addressLosses: 0,
  });
  const coupled = (id: string, mac: string, peerMac: string, ipv4: string, hostMemoryGb: number | null = null, vllmFeatures = [GROUP_MEMBER_FEATURE]) => makeNode({
    id, estCapacity: 45, gpuCount: 1, hostMemoryGb, driverVersions: { vllm: "0.31.0" }, driverFeatures: { vllm: vllmFeatures },
    gpus: [{ vendor: "nvidia", name: "L40S", vramMb: 46080, uuid: `${id}-gpu` }],
    interconnect: [{ networkCard: "cx7", port: "p0", paths: [path(mac, ipv4)], neighbours: [peerMac] }],
  });
  const pair = (hostA: number | null = null, hostB: number | null = null) => [
    coupled("node-a", "aa", "bb", "192.168.100.1/24", hostA),
    coupled("node-b", "bb", "aa", "192.168.100.2/24", hostB),
  ];
  const model = (weightGb: number, sizing: Partial<FootprintEntry["sizing"]> = {}) => ({
    weight: weightGb, attentionHeads: 24, kvHeads: 4,
    footprint: {
      sizing: { weightGb, minKvCacheGb: 4, maxContextLength: 32768, attentionHeads: 24, kvHeads: 4, hostWeightGb: 0, layers: 48, attentionLayers: 48, ...sizing },
      tags: [], placement: { limits: [] },
    },
  });
  const need = (weightGb: number, goal: "space" | "speed" = "space", sizing: Partial<FootprintEntry["sizing"]> = {}) => ({ model: model(weightGb, sizing), kvCacheGb: 4, goal });
  const nodesOf = (found: ReturnType<typeof findPlacement>) => found?.members.map((member) => member.nodeId);

  test("serves a model no single node holds across the coupled pair", () => {
    const found = findPlacement(placement, "vllm", need(60), buildClusterState([], pair()), [], FF);
    expect(nodesOf(found)).toEqual(["node-a", "node-b"]);
    expect(found!.coupling?.nodeIds).toEqual(["node-a", "node-b"]);
  });

  test("spans two machines with unified memory, whose cards report no size of their own", () => {
    const gx10 = (node: ReturnType<typeof coupled>, estCapacity: number) => ({
      ...node, estCapacity, hostMemoryGb: estCapacity + 8,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GB10", vramMb: 0, uuid: `${node.id}-gpu` }],
    });
    const [a, b] = pair();
    const state = buildClusterState([], [gx10(a!, 107), gx10(b!, 109)]);
    const found = findPlacement(placement, "vllm", need(135.5, "space", { hostWeightGb: 51.2 }), state, [], FF);
    expect(nodesOf(found)).toEqual(["node-a", "node-b"]);
  });

  test("leaves out a machine that cannot run a member, rootless Docker or no RDMA devices", () => {
    const state = buildClusterState([], [coupled("node-a", "aa", "bb", "192.168.100.1/24"), coupled("node-b", "bb", "aa", "192.168.100.2/24", null, [])]);
    expect(findPlacement(placement, "vllm", need(60), state, [], FF)).toBeNull();
  });

  test("space stays on one node when one holds the model, speed spans the pair for more cards", () => {
    const state = buildClusterState([], pair());
    expect(nodesOf(findPlacement(placement, "vllm", need(20), state, [], FF))).toEqual(["node-a"]);
    expect(nodesOf(findPlacement(placement, "vllm", need(20, "speed"), state, [], FF))).toEqual(["node-a", "node-b"]);
  });

  test("gives rank 0 to the node that has room for rank 0's part but not for a follower's", () => {
    // A text model's rank 0 needs 5.5 GiB of host memory, every follower 6 GiB, each plus one pinned communicator.
    const leaderOnly = (5.5 + 1.25) * GIB + 0.1;
    const found = findPlacement(placement, "vllm", need(60), buildClusterState([], pair(null, leaderOnly)), [], FF);
    expect(nodesOf(found)).toEqual(["node-b", "node-a"]);
  });

  test("keeps a node out that holds the steady part but not what loading holds besides it", () => {
    const hostGb = 5.5 * GIB + 1;
    const nodes = [coupled("node-a", "aa", "bb", "192.168.100.1/24", hostGb)];
    expect(findServerForModel(placement, "vllm", need(20), buildClusterState([], nodes), [], FF)).toBe("node-a");
    expect(findServerForModel(placement, "vllm", need(20, "space", { largestFileGb: 1 }), buildClusterState([], nodes), [], FF)).toBeNull();
  });

  const member = (id: string, nodeId: string, rank: number, size = 2) => makeInstallation({
    id, nodeId, specifier: "big", driver: "vllm",
    group: { id: "group-1", rank, size, rendezvousPort: 29500, generation: 1, addresses: [{ subnet: "192.168.100.0/24", address: `192.168.100.${254 - rank}` }] },
  });
  const requirement = (replicas: number): ModelRequirementTable => ({
    "dep-1:big": { deploymentId: "dep-1", specifier: "big", replicas, preferredDriver: "vllm", settings: { version: 1 } } as ModelRequirement,
  });

  test("counts a group as one replica and trims it whole", () => {
    const members = [member("m0", "node-a", 0), member("m1", "node-b", 1)];
    expect(collectExcessInstallations(requirement(1), buildClusterState(members, pair()))).toEqual([]);
    expect(collectExcessInstallations(requirement(0), buildClusterState(members, pair())).sort()).toEqual(["m0", "m1"]);
  });

  test("replaces a whole group when one member cannot fit on its node, or a member is missing", () => {
    const members = [member("m0", "node-a", 0), member("m1", "node-b", 1)];
    expect(collectReplicasThatDoNotFit(new Set(["m1"]), buildClusterState(members, pair())).sort()).toEqual(["m0", "m1"]);
    const lonely = [member("m0", "node-a", 0)];
    expect(collectIncompleteGroups(lonely, buildClusterState(lonely, pair()))).toEqual(["m0"]);
  });
});
