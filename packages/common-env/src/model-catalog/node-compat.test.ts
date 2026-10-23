import { describe, test, expect } from "bun:test";
import { checkNodeCompatibility, blockedVersionNotes, type DeployableModel, type NodeCapability, type ModelNodeRequirements } from "./node-compat";
import type { GpuInfo } from "../tether-protocol";
import { nearestIncompatibility } from "./incompatibility";

const nvidiaGpu: GpuInfo = { vendor: "nvidia", name: "A100", vramMb: 81920 };
const amdGpu: GpuInfo = { vendor: "amd", name: "MI300X", vramMb: 196608 };

function makeNode(overrides?: Partial<NodeCapability>): NodeCapability {
  return {
    free: 24,
    driverVersions: { vllm: "0.20.0", ollama: "0.6.3" },
    gpus: [nvidiaGpu],
    ...overrides,
  };
}

function makeReq(overrides?: Partial<ModelNodeRequirements>): ModelNodeRequirements {
  return {
    driver: "vllm",
    capacityGb: 8,
    requiredPlatforms: [],
    ...overrides,
  };
}

describe("nearestIncompatibility", () => {
  test("one workable candidate clears the whole set", () => {
    expect(nearestIncompatibility(["missing_driver", null, "insufficient_capacity"])).toBeNull();
  });

  test("reports the candidate that got furthest through the checks", () => {
    expect(nearestIncompatibility(["missing_driver", "wrong_platform", "version_too_old"])).toBe("wrong_platform");
  });

  test("reports missing_driver for no candidates at all", () => {
    expect(nearestIncompatibility([])).toBe("missing_driver");
  });
});

describe("checkNodeCompatibility", () => {
  test("returns null when all constraints satisfied", () => {
    expect(checkNodeCompatibility(makeNode(), makeReq())).toBeNull();
  });

  test("returns missing_driver when driver not available", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { ollama: "0.6.3" } }),
      makeReq({ driver: "vllm" }),
    )).toBe("missing_driver");
  });

  test("returns missing_driver when driverVersions is empty (no successful probes)", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: {} }),
      makeReq({ driver: "vllm" }),
    )).toBe("missing_driver");
  });

  test("returns version_too_old when version insufficient", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "0.18.0" } }),
      makeReq({ minVersion: "0.19.1" }),
    )).toBe("version_too_old");
  });

  test("passes version check when node version is sufficient", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "0.20.0" } }),
      makeReq({ minVersion: "0.19.1" }),
    )).toBeNull();
  });

  test("skips version check when driver is present but its version is empty (fail-open by default)", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "" } }),
      makeReq({ minVersion: "0.19.1" }),
    )).toBeNull();
  });

  test("returns version_unknown when requireKnownVersion is true and the driver's version is empty", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "" } }),
      makeReq({ minVersion: "0.19.1" }),
      { requireKnownVersion: true },
    )).toBe("version_unknown");
  });

  test("requireKnownVersion does not affect nodes whose reported version is sufficient", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "0.20.0" } }),
      makeReq({ minVersion: "0.19.1" }),
      { requireKnownVersion: true },
    )).toBeNull();
  });

  test("requireKnownVersion still returns version_too_old when reported version is too low", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "0.18.0" } }),
      makeReq({ minVersion: "0.19.1" }),
      { requireKnownVersion: true },
    )).toBe("version_too_old");
  });

  test("requireKnownVersion is ignored when the model has no minVersion", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "" } }),
      makeReq(),
      { requireKnownVersion: true },
    )).toBeNull();
  });

  test("returns missing_feature when node lacks a required feature", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverFeatures: { vllm: [] } }),
      makeReq({ requiredFeatures: ["audio"] }),
    )).toBe("missing_feature");
  });

  test("returns missing_feature when node has no driverFeatures (backward compat)", () => {
    expect(checkNodeCompatibility(
      makeNode(),
      makeReq({ requiredFeatures: ["audio"] }),
    )).toBe("missing_feature");
  });

  test("passes feature check when node has the required feature", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverFeatures: { vllm: ["audio"] } }),
      makeReq({ requiredFeatures: ["audio"] }),
    )).toBeNull();
  });

  test("skips feature check when no features are required", () => {
    expect(checkNodeCompatibility(
      makeNode(),
      makeReq(),
    )).toBeNull();
  });

  test("check order: feature before platform", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverFeatures: { vllm: [] }, gpus: [amdGpu] }),
      makeReq({ requiredFeatures: ["audio"], requiredPlatforms: ["nvidia"] }),
    )).toBe("missing_feature");
  });

  test("returns wrong_platform when GPU vendor doesn't match", () => {
    expect(checkNodeCompatibility(
      makeNode({ gpus: [amdGpu] }),
      makeReq({ requiredPlatforms: ["nvidia"] }),
    )).toBe("wrong_platform");
  });

  test("passes platform check when vendor matches", () => {
    expect(checkNodeCompatibility(
      makeNode({ gpus: [nvidiaGpu] }),
      makeReq({ requiredPlatforms: ["nvidia"] }),
    )).toBeNull();
  });

  test("passes platform check when any GPU vendor matches", () => {
    expect(checkNodeCompatibility(
      makeNode({ gpus: [amdGpu, nvidiaGpu] }),
      makeReq({ requiredPlatforms: ["nvidia"] }),
    )).toBeNull();
  });

  test("rejects node with no GPUs when platform is required (fail-closed)", () => {
    expect(checkNodeCompatibility(
      makeNode({ gpus: [] }),
      makeReq({ requiredPlatforms: ["nvidia"] }),
    )).toBe("wrong_platform");
  });

  test("skips platform check when model has no platform requirement", () => {
    expect(checkNodeCompatibility(
      makeNode({ gpus: [amdGpu] }),
      makeReq({ requiredPlatforms: [] }),
    )).toBeNull();
  });

  test("returns insufficient_capacity when not enough free space", () => {
    expect(checkNodeCompatibility(
      makeNode({ free: 4 }),
      makeReq({ capacityGb: 8 }),
    )).toBe("insufficient_capacity");
  });

  test("checks constraints in order: driver before version before platform before capacity", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: {}, gpus: [amdGpu], free: 0 }),
      makeReq({ minVersion: "0.19.1", requiredPlatforms: ["nvidia"], capacityGb: 100 }),
    )).toBe("missing_driver");
  });
});

describe("checkNodeCompatibility blocked versions", () => {
  const blocked = [{ range: ">=0.27.0 <0.27.3", reason: "attention kernel shape mismatch, fixed in 0.27.3" }];

  test("excludes a node running a release the model blocks", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "0.27.1" } }),
      makeReq({ blockedVersions: blocked }),
    )).toBe("version_blocked");
  });

  test("clears a node running a release either side of the blocked range", () => {
    for (const version of ["0.26.9", "0.27.3"]) {
      expect(checkNodeCompatibility(
        makeNode({ driverVersions: { vllm: version } }),
        makeReq({ blockedVersions: blocked }),
      )).toBeNull();
    }
  });

  test("matches a PEP440 node version against the range", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "0.27.1.post1+cu126" } }),
      makeReq({ blockedVersions: blocked }),
    )).toBe("version_blocked");
  });

  test("reports the floor first, since upgrading past it is the nearer fix", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "0.19.0" } }),
      makeReq({ minVersion: "0.21.0", blockedVersions: blocked }),
    )).toBe("version_too_old");
  });

  /** Excluding a node whose version never probed takes the cluster out over a release it may not run. */
  test("does not exclude a node whose engine version is undetectable", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "" } }),
      makeReq({ blockedVersions: blocked }),
    )).toBeNull();
  });

  test("still flags an undetectable version when the caller demands one", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "" } }),
      makeReq({ blockedVersions: blocked }),
      { requireKnownVersion: true },
    )).toBe("version_unknown");
  });

  test("ranks a blocked version above missing_driver and below capacity", () => {
    expect(nearestIncompatibility(["missing_driver", "version_blocked"])).toBe("version_blocked");
    expect(nearestIncompatibility(["version_blocked", "insufficient_capacity"])).toBe("insufficient_capacity");
  });
});

describe("blockedVersionNotes", () => {
  const model: DeployableModel = {
    engine: "vllm",
    type: "chat",
    sizing: { weightGb: 8, minKvCacheGb: 2 } as DeployableModel["sizing"],
    engineVersions: {
      rules: [
        { range: "0.27.1", effect: "blocked", reason: "crashes on the first request" },
        { range: ">=0.30.0 <0.30.4", effect: "blocked", reason: "tool calls come back empty" },
      ],
    },
  };

  function nodesOn(...versions: string[]): NodeCapability[] {
    return versions.map(vllm => makeNode({ driverVersions: { vllm } }));
  }

  test("reports only the releases the cluster is actually running", () => {
    expect(blockedVersionNotes(nodesOn("0.27.1"), model)).toEqual(["crashes on the first request"]);
  });

  test("reports every matching release when the fleet runs several", () => {
    expect(blockedVersionNotes(nodesOn("0.27.1", "0.30.2"), model)).toHaveLength(2);
  });

  test("says nothing when no node runs an excluded release", () => {
    expect(blockedVersionNotes(nodesOn("0.28.0", "0.31.0"), model)).toEqual([]);
  });

  test("says nothing for a model that excludes none, or a cluster of unknown versions", () => {
    expect(blockedVersionNotes(nodesOn("0.27.1"), { ...model, engineVersions: undefined })).toEqual([]);
    expect(blockedVersionNotes(nodesOn(""), model)).toEqual([]);
  });
});
