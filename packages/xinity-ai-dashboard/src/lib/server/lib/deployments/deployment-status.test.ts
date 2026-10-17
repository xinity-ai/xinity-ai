import { describe, test, expect } from "bun:test";
import { foldDeploymentStatusRows, type DeploymentStatusRow } from "./deployment-status";

const DEPLOYMENT: DeploymentStatusRow["model_deployment"] = {
  id: "dep-1",
  organizationId: "org-1",
  name: "My Deployment",
  description: null,
  enabled: true,
  publicSpecifier: "qwen3.6-27b",
  specifier: "qwen3.6-27b",
  earlySpecifier: null,
  replicas: 4,
  canaryProgressUntil: null,
  canaryProgressFrom: null,
  canaryProgressWithFeedback: false,
  progress: 100,
  kvCacheSize: null,
  earlyKvCacheSize: null,
  preferredDriver: null,
  settings: { version: 1 },
  deletedAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

type State = NonNullable<DeploymentStatusRow["model_installation_state"]>;

function row(overrides: Partial<DeploymentStatusRow> = {}): DeploymentStatusRow {
  return {
    model_deployment: DEPLOYMENT,
    model_installation: { id: "inst-1", group: null },
    model_installation_state: state(),
    ai_node: { machineName: "gx10-a", host: "192.0.2.1" },
    ...overrides,
  };
}

function state(overrides: Partial<State> = {}): State {
  return { lifecycleState: "ready", progress: null, errorMessage: null, failureLogs: null, ...overrides };
}

/** One live, ready replica per id. */
function replicas(count: number): DeploymentStatusRow[] {
  return Array.from({ length: count }, (_, i) => row({
    model_installation: { id: `inst-${i}`, group: null },
    ai_node: { machineName: `gx10-${i}`, host: `192.0.2.${i + 1}` },
  }));
}

describe("foldDeploymentStatusRows", () => {
  test("reports one replica per installation row", () => {
    const [deployment] = foldDeploymentStatusRows(replicas(3));
    expect(deployment!.status!.replicas).toHaveLength(3);
    expect(deployment!.status!.phase).toBe("ready");
  });

  test("ignores a replica whose node left the cluster, even while its state still reads ready", () => {
    const [deployment] = foldDeploymentStatusRows([
      ...replicas(2),
      row({ model_installation: { id: "inst-gone", group: null }, ai_node: null }),
    ]);
    expect(deployment!.status!.replicas).toHaveLength(2);
    expect(deployment!.status!.phase).toBe("ready");
  });

  test("reports no status when every installation sits on a node that left the cluster", () => {
    const [deployment] = foldDeploymentStatusRows([
      row({ model_installation: { id: "inst-0", group: null }, ai_node: null }),
      row({ model_installation: { id: "inst-1", group: null }, ai_node: null }),
    ]);
    expect(deployment!.status).toBeUndefined();
    expect(deployment!.id).toBe("dep-1");
  });

  test("reports no status for a deployment with no installations at all", () => {
    const [deployment] = foldDeploymentStatusRows([
      row({ model_installation: null, model_installation_state: null, ai_node: null }),
    ]);
    expect(deployment!.status).toBeUndefined();
  });

  test("labels a replica by machine name, falling back to host", () => {
    const [deployment] = foldDeploymentStatusRows([
      row({ model_installation: { id: "inst-0", group: null }, ai_node: { machineName: "gx10-a", host: "192.0.2.1" } }),
      row({ model_installation: { id: "inst-1", group: null }, ai_node: { machineName: null, host: "192.0.2.2" } }),
    ]);
    expect(deployment!.status!.replicas!.map(r => r.node)).toEqual(["gx10-a", "192.0.2.2"]);
  });

  test("treats an installation with no state row as scheduling", () => {
    const [deployment] = foldDeploymentStatusRows([
      row({ model_installation_state: null }),
    ]);
    expect(deployment!.status!.phase).toBe("scheduling");
    expect(deployment!.status!.replicas).toEqual([{ phase: "scheduling", node: "gx10-a", error: null }]);
  });

  test("aggregates the worst phase across replicas", () => {
    const [deployment] = foldDeploymentStatusRows([
      row({ model_installation: { id: "inst-0", group: null } }),
      row({ model_installation: { id: "inst-1", group: null }, model_installation_state: state({ lifecycleState: "downloading", progress: 42 }) }),
    ]);
    expect(deployment!.status!.phase).toBe("downloading");
    expect(deployment!.status!.progress).toBe(42);
  });

  test("reports partial when some replicas failed and others are ready", () => {
    const [deployment] = foldDeploymentStatusRows([
      row({ model_installation: { id: "inst-0", group: null } }),
      row({ model_installation: { id: "inst-1", group: null }, model_installation_state: state({ lifecycleState: "failed", errorMessage: "boom" }) }),
    ]);
    expect(deployment!.status!.phase).toBe("partial");
    expect(deployment!.status!.error).toBe("boom");
  });

  test("keeps deployments separate", () => {
    const other = { ...DEPLOYMENT, id: "dep-2", name: "Other" };
    const result = foldDeploymentStatusRows([
      ...replicas(2),
      row({ model_deployment: other, model_installation: { id: "inst-x", group: null } }),
    ]);
    expect(result).toHaveLength(2);
    expect(result.find(d => d.id === "dep-1")!.status!.replicas).toHaveLength(2);
    expect(result.find(d => d.id === "dep-2")!.status!.replicas).toHaveLength(1);
  });
});

describe("a replica served across machines", () => {
  const group = (rank: number) => ({ id: "group-1", rank, size: 2, rendezvousPort: 29500, generation: 1, addresses: [] });
  const member = (rank: number, overrides: Partial<State> = {}, node: DeploymentStatusRow["ai_node"] = { machineName: `gx10-${rank}`, host: `192.0.2.${rank + 1}` }) => row({
    model_installation: { id: `inst-${rank}`, group: group(rank) },
    model_installation_state: state(overrides),
    ai_node: node,
  });

  test("is one replica, named after rank 0, with each machine's detail by rank", () => {
    const [deployment] = foldDeploymentStatusRows([member(1, { lifecycleState: "installing" }), member(0)]);
    expect(deployment!.status!.replicas).toEqual([{
      phase: "installing", node: "gx10-0", error: null,
      members: [{ node: "gx10-0", phase: "ready", error: null }, { node: "gx10-1", phase: "installing", error: null }],
    }]);
    expect(deployment!.status!.phase).toBe("installing");
  });

  test("is failed, not partial, when one machine failed while the other is ready", () => {
    const [deployment] = foldDeploymentStatusRows([member(0), member(1, { lifecycleState: "failed", errorMessage: "NCCL communication error" })]);
    expect(deployment!.status!.phase).toBe("failed");
    expect(deployment!.status!.error).toBe("NCCL communication error");
  });

  test("is still scheduling while one of its machines left the cluster", () => {
    const [deployment] = foldDeploymentStatusRows([member(0), member(1, {}, null)]);
    expect(deployment!.status!.replicas!.map((replica) => replica.phase)).toEqual(["scheduling"]);
  });

  test("is ready once every machine is", () => {
    const [deployment] = foldDeploymentStatusRows([member(0), member(1), ...replicas(1)]);
    expect(deployment!.status!.replicas).toHaveLength(2);
    expect(deployment!.status!.phase).toBe("ready");
  });
});
