import { describe, test, expect } from "bun:test";
import { couplingIssuesOf, foldDeploymentStatusRows, type DeploymentStatusRow } from "./deployment-status";
import type { InterconnectPath, InterconnectPort } from "common-env";

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
type Installation = NonNullable<DeploymentStatusRow["model_installation"]>;

function installation(id: string, group: Installation["group"]): Installation {
  return { id, group, gpuIds: ["gpu-0"], estCapacity: 60, hostCapacity: 8 };
}

function row(overrides: Partial<DeploymentStatusRow> = {}): DeploymentStatusRow {
  return {
    model_deployment: DEPLOYMENT,
    model_installation: installation("inst-1", null),
    model_installation_state: state(),
    ai_node: { id: "192.0.2.1", interconnect: [], machineName: "gx10-a", host: "192.0.2.1" },
    ...overrides,
  };
}

function state(overrides: Partial<State> = {}): State {
  return { lifecycleState: "ready", progress: null, errorMessage: null, failureLogs: null, ...overrides };
}

/** One live, ready replica per id. */
function replicas(count: number): DeploymentStatusRow[] {
  return Array.from({ length: count }, (_, i) => row({
    model_installation: installation(`inst-${i}`, null),
    ai_node: { id: `node-${i}`, interconnect: [], machineName: `gx10-${i}`, host: `192.0.2.${i + 1}` },
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
      row({ model_installation: installation("inst-gone", null), ai_node: null }),
    ]);
    expect(deployment!.status!.replicas).toHaveLength(2);
    expect(deployment!.status!.phase).toBe("ready");
  });

  test("reports no status when every installation sits on a node that left the cluster", () => {
    const [deployment] = foldDeploymentStatusRows([
      row({ model_installation: installation("inst-0", null), ai_node: null }),
      row({ model_installation: installation("inst-1", null), ai_node: null }),
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
      row({ model_installation: installation("inst-0", null), ai_node: { id: "192.0.2.1", interconnect: [], machineName: "gx10-a", host: "192.0.2.1" } }),
      row({ model_installation: installation("inst-1", null), ai_node: { id: "192.0.2.2", interconnect: [], machineName: null, host: "192.0.2.2" } }),
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
      row({ model_installation: installation("inst-0", null) }),
      row({ model_installation: installation("inst-1", null), model_installation_state: state({ lifecycleState: "downloading", progress: 42 }) }),
    ]);
    expect(deployment!.status!.phase).toBe("downloading");
    expect(deployment!.status!.progress).toBe(42);
  });

  test("reports partial when some replicas failed and others are ready", () => {
    const [deployment] = foldDeploymentStatusRows([
      row({ model_installation: installation("inst-0", null) }),
      row({ model_installation: installation("inst-1", null), model_installation_state: state({ lifecycleState: "failed", errorMessage: "boom" }) }),
    ]);
    expect(deployment!.status!.phase).toBe("partial");
    expect(deployment!.status!.error).toBe("boom");
  });

  test("keeps deployments separate", () => {
    const other = { ...DEPLOYMENT, id: "dep-2", name: "Other" };
    const result = foldDeploymentStatusRows([
      ...replicas(2),
      row({ model_deployment: other, model_installation: installation("inst-x", null) }),
    ]);
    expect(result).toHaveLength(2);
    expect(result.find(d => d.id === "dep-1")!.status!.replicas).toHaveLength(2);
    expect(result.find(d => d.id === "dep-2")!.status!.replicas).toHaveLength(1);
  });
});

describe("a replica served across machines", () => {
  const group = (rank: number) => ({ id: "group-1", rank, size: 2, parallelism: "tensor" as const, rendezvousPort: 29500, generation: 1, addresses: [] });
  const member = (rank: number, overrides: Partial<State> = {}, node: DeploymentStatusRow["ai_node"] = { id: `node-${rank}`, interconnect: [], machineName: `gx10-${rank}`, host: `192.0.2.${rank + 1}` }) => row({
    model_installation: installation(`inst-${rank}`, group(rank)),
    model_installation_state: state(overrides),
    ai_node: node,
  });

  test("is one replica, named after rank 0, with each machine's detail by rank", () => {
    const [deployment] = foldDeploymentStatusRows([member(1, { lifecycleState: "installing" }), member(0)]);
    expect(deployment!.status!.replicas).toEqual([{
      phase: "installing", node: "gx10-0", error: null,
      members: [
        { node: "gx10-0", phase: "ready", error: null, cards: 1, gpuGb: 60, hostGb: 8 },
        { node: "gx10-1", phase: "installing", error: null, cards: 1, gpuGb: 60, hostGb: 8 },
      ],
      couplingIssues: [expect.objectContaining({ text: "its machines are no longer coupled" })],
    }]);
    expect(deployment!.status!.phase).toBe("installing");
  });

  test("is failed, not partial, when one machine failed while the other is ready", () => {
    const [deployment] = foldDeploymentStatusRows([member(0), member(1, { lifecycleState: "failed", errorMessage: "NCCL communication error" })]);
    expect(deployment!.status!.phase).toBe("failed");
    expect(deployment!.status!.error).toBe("NCCL communication error");
  });

  test("names an error every machine shares once, on the replica, and keeps errors that differ by machine", () => {
    const coupling = "No coupled port on 192.168.100.0/24";
    const [shared] = foldDeploymentStatusRows([
      member(0, { lifecycleState: "failed", errorMessage: coupling }),
      member(1, { lifecycleState: "failed", errorMessage: coupling }),
    ])[0]!.status!.replicas!;
    expect(shared!.error).toBe(coupling);
    expect(shared!.members!.map(({ error }) => error)).toEqual([null, null]);

    const [differing] = foldDeploymentStatusRows([
      member(0, { lifecycleState: "failed", errorMessage: "Stopped, another machine of its group failed" }),
      member(1, { lifecycleState: "failed", errorMessage: "Stopped, over its host memory budget" }),
    ])[0]!.status!.replicas!;
    expect(differing!.members!.map(({ error }) => error)).toEqual(["Stopped, another machine of its group failed", "Stopped, over its host memory budget"]);
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

describe("couplingIssuesOf", () => {
  const path = (mac: string, ipv4: string, overrides: Partial<InterconnectPath> = {}): InterconnectPath => ({
    interface: `if-${mac.slice(-2)}`, mac, carrier: true, mtu: 9000, speedMbps: 200000, linkLayer: "Ethernet",
    ipv4: [ipv4], roceV2Ipv4: [ipv4.split("/")[0]!], addressLosses: 0, ...overrides,
  });
  const port = (paths: InterconnectPath[], neighbours: string[]): InterconnectPort => ({ networkCard: "card", port: "p0", paths, neighbours });
  const pair = (bPath: Partial<InterconnectPath> = {}, bNeighbours = ["d6:15"], aNeighbours = ["a9:39", "ff:01"]) => [
    { nodeId: "a", node: "gx10-a", interconnect: [port([path("d6:15", "192.168.100.1/24")], aNeighbours)] },
    { nodeId: "b", node: "gx10-b", interconnect: [port([path("a9:39", "192.168.100.2/24", bPath)], bNeighbours)] },
  ];

  test("finds nothing wrong with a healthy coupling, though a machine outside the group answers on it", () => {
    expect(couplingIssuesOf(pair())).toEqual([]);
  });

  test("names the machine whose coupled port degraded", () => {
    expect(couplingIssuesOf(pair({ mtu: 1500 })).map(({ text }) => text)).toContain("gx10-b: if-39 runs at MTU 1500, RDMA needs 9000 for full speed");
  });

  test("says the machines are no longer coupled once no cable joins them", () => {
    expect(couplingIssuesOf(pair({}, [], [])).map(({ text }) => text)).toEqual(["its machines are no longer coupled"]);
  });
});
