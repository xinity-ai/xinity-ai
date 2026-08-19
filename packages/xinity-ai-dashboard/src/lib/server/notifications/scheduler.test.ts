import { describe, test, expect, mock } from "bun:test";

mock.module("$lib/server/logging", () => ({
  rootLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
mock.module("$lib/server/db", () => ({ getDB: () => { throw new Error("db unused in these tests"); } }));

const { foldDeploymentPhaseRows } = await import("./scheduler");
type Row = Parameters<typeof foldDeploymentPhaseRows>[0][number];

function row(overrides: Partial<Row> = {}): Row {
  return {
    deploymentId: "dep-1",
    deploymentName: "My Deployment",
    organizationId: "org-1",
    orgName: "Acme",
    publicSpecifier: "qwen3.6-27b",
    desiredReplicas: 4,
    installationId: "inst-1",
    lifecycleState: "ready",
    errorMessage: null,
    ...overrides,
  };
}

/** One installation row per id, all in the given phase. */
function installations(count: number, lifecycleState = "ready"): Row[] {
  return Array.from({ length: count }, (_, i) => row({ installationId: `inst-${i}`, lifecycleState }));
}

describe("foldDeploymentPhaseRows", () => {
  test("counts one observed replica per installation row", () => {
    const info = foldDeploymentPhaseRows(installations(3)).get("dep-1")!;
    expect(info.observedReplicas).toBe(3);
    expect(info.desiredReplicas).toBe(4);
    expect(info.phase).toBe("ready");
  });

  test("counts zero observed for a deployment with no installations", () => {
    const info = foldDeploymentPhaseRows([
      row({ installationId: null, lifecycleState: null }),
    ]).get("dep-1")!;
    expect(info.observedReplicas).toBe(0);
    expect(info.phase).toBe("pending");
  });

  test("reports a fully provisioned deployment as observed equal to desired", () => {
    const info = foldDeploymentPhaseRows(installations(4)).get("dep-1")!;
    expect(info.observedReplicas).toBe(4);
    expect(info.desiredReplicas).toBe(4);
  });

  test("carries the desired count through from the deployment row", () => {
    const info = foldDeploymentPhaseRows([row({ desiredReplicas: 9 })]).get("dep-1")!;
    expect(info.desiredReplicas).toBe(9);
  });

  test("keeps deployments separate and counts each independently", () => {
    const result = foldDeploymentPhaseRows([
      ...installations(2),
      row({ deploymentId: "dep-2", deploymentName: "Other", desiredReplicas: 1, installationId: "inst-x" }),
    ]);
    expect(result.get("dep-1")!.observedReplicas).toBe(2);
    expect(result.get("dep-2")!.observedReplicas).toBe(1);
    expect(result.get("dep-2")!.desiredReplicas).toBe(1);
  });

  test("still aggregates the worst phase across installations", () => {
    const info = foldDeploymentPhaseRows([
      row({ installationId: "inst-0", lifecycleState: "ready" }),
      row({ installationId: "inst-1", lifecycleState: "downloading" }),
    ]).get("dep-1")!;
    expect(info.phase).toBe("downloading");
    expect(info.observedReplicas).toBe(2);
  });

  test("reports partial when some installations failed and others are ready", () => {
    const info = foldDeploymentPhaseRows([
      row({ installationId: "inst-0", lifecycleState: "ready" }),
      row({ installationId: "inst-1", lifecycleState: "failed", errorMessage: "boom" }),
    ]).get("dep-1")!;
    expect(info.phase).toBe("partial");
    expect(info.error).toBe("boom");
    expect(info.observedReplicas).toBe(2);
  });

  test("treats an installation without state as scheduling and still counts it", () => {
    const info = foldDeploymentPhaseRows([
      row({ installationId: "inst-0", lifecycleState: null }),
    ]).get("dep-1")!;
    expect(info.phase).toBe("scheduling");
    expect(info.observedReplicas).toBe(1);
  });

  test("an all-ready but under-provisioned deployment reports ready with a shortfall", () => {
    const info = foldDeploymentPhaseRows(installations(3)).get("dep-1")!;
    expect(info.phase).toBe("ready");
    expect(info.observedReplicas).toBeLessThan(info.desiredReplicas);
  });
});
