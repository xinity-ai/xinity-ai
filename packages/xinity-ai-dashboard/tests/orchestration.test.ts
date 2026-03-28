import { describe, test, expect } from "bun:test";
import { buildClusterState, collectExcessInstallations, findServerForModel } from "../src/lib/server/lib/orchestration.mod";
import type { AiNode, ModelInstallation } from "common-db";
import type { ModelRequirementTable } from "../src/lib/server/lib/orchestration.mod";

function makeNode(overrides: Partial<AiNode> & { id: string }): AiNode {
  return {
    host: "10.0.0.1",
    port: 9090,
    estCapacity: 24,
    available: true,
    drivers: ["ollama"],
    gpuCount: 1,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeInstallation(overrides: Partial<ModelInstallation> & { id: string; nodeId: string; model: string }): ModelInstallation {
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
  const nodeB = makeNode({ id: "node-b", host: "10.0.0.2" });

  test("installations on a downed node are not counted, and replacement is planned on a healthy node", () => {
    // node-b just went offline — syncDeployedModels filters it out of availableServers
    // and partitions its installations as orphaned. We simulate that here:
    const availableServers = [nodeA];
    const allInstallations = [
      makeInstallation({ id: "inst-1", nodeId: "node-b", model: "llama2:7b" }),
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
    const requiredModels: ModelRequirementTable = { "llama2:7b": { replicas: 1, kvCacheSize: 2 } };
    const excess = collectExcessInstallations(requiredModels, state);
    expect(excess).toHaveLength(0);

    // Planner would place the replacement on node-a
    const replacement = findServerForModel("llama2:7b", "ollama", 8, state, []);
    expect(replacement).toBe("node-a");
  });

  test("findServerForModel skips nodes missing the required driver", () => {
    const ollamaOnly = makeNode({ id: "node-c", host: "10.0.0.3", drivers: ["ollama"] });
    const state = buildClusterState([], [ollamaOnly]);

    expect(findServerForModel("some-model", "vllm", 8, state, [])).toBeNull();
  });

  test("findServerForModel skips nodes without enough capacity", () => {
    const tinyNode = makeNode({ id: "node-d", host: "10.0.0.4", estCapacity: 4 });
    const state = buildClusterState([], [tinyNode]);

    expect(findServerForModel("big-model", "ollama", 16, state, [])).toBeNull();
  });
});
