import { describe, test, expect } from "bun:test";
import { checkNodeCompatibility, isDeployableOnCluster, type NodeCapability, type ModelNodeRequirements, type GpuInfo } from "./node-compat";

const nvidiaGpu: GpuInfo = { vendor: "nvidia", name: "A100", vramMb: 81920 };
const amdGpu: GpuInfo = { vendor: "amd", name: "MI300X", vramMb: 196608 };

function makeNode(overrides?: Partial<NodeCapability>): NodeCapability {
  return {
    free: 24,
    drivers: ["vllm", "ollama"],
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

describe("checkNodeCompatibility", () => {
  test("returns null when all constraints satisfied", () => {
    expect(checkNodeCompatibility(makeNode(), makeReq())).toBeNull();
  });

  test("returns missing_driver when driver not available", () => {
    expect(checkNodeCompatibility(
      makeNode({ drivers: ["ollama"] }),
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

  test("skips version check when node has no version info (fail-open)", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: {} }),
      makeReq({ minVersion: "0.19.1" }),
    )).toBeNull();
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
      makeNode({ drivers: [], driverVersions: {}, gpus: [amdGpu], free: 0 }),
      makeReq({ minVersion: "0.19.1", requiredPlatforms: ["nvidia"], capacityGb: 100 }),
    )).toBe("missing_driver");
  });

  test("combined: version ok + platform ok + capacity ok = compatible", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "0.19.1" }, gpus: [nvidiaGpu], free: 16 }),
      makeReq({ minVersion: "0.19.1", requiredPlatforms: ["nvidia"], capacityGb: 16 }),
    )).toBeNull();
  });

  test("combined: version ok + wrong platform = wrong_platform (not capacity)", () => {
    expect(checkNodeCompatibility(
      makeNode({ driverVersions: { vllm: "0.20.0" }, gpus: [amdGpu], free: 100 }),
      makeReq({ minVersion: "0.19.1", requiredPlatforms: ["nvidia"], capacityGb: 8 }),
    )).toBe("wrong_platform");
  });
});

describe("isDeployableOnCluster", () => {
  const model = {
    weight: 8,
    minKvCache: 2,
    providers: { vllm: "org/model" as string | undefined, ollama: undefined },
    providerMinVersions: { vllm: "0.19.1" },
    providerPlatforms: { vllm: ["nvidia"] },
  };

  test("returns true when a compatible node exists", () => {
    expect(isDeployableOnCluster([makeNode()], model)).toBe(true);
  });

  test("returns false when no node has enough capacity", () => {
    expect(isDeployableOnCluster([makeNode({ free: 4 })], model)).toBe(false);
  });

  test("returns false when no node has right platform", () => {
    expect(isDeployableOnCluster([makeNode({ gpus: [amdGpu] })], model)).toBe(false);
  });

  test("returns false when no node has right version", () => {
    expect(isDeployableOnCluster(
      [makeNode({ driverVersions: { vllm: "0.18.0" } })],
      model,
    )).toBe(false);
  });

  test("returns false when capacity and platform are on different nodes", () => {
    expect(isDeployableOnCluster([
      makeNode({ gpus: [nvidiaGpu], free: 4 }),
      makeNode({ gpus: [amdGpu], free: 24 }),
    ], model)).toBe(false);
  });

  test("tries all providers - passes if any works", () => {
    const multiProviderModel = {
      weight: 8, minKvCache: 2,
      providers: { vllm: "org/model" as string | undefined, ollama: "model" as string | undefined },
    };
    expect(isDeployableOnCluster(
      [makeNode({ drivers: ["ollama"], driverVersions: {} })],
      multiProviderModel,
    )).toBe(true);
  });

  test("returns false with empty cluster", () => {
    const zeroModel = { weight: 0, minKvCache: 0, providers: { ollama: "m" as string | undefined } };
    expect(isDeployableOnCluster([], zeroModel)).toBe(false);
  });

  test("model without providerMinVersions or providerPlatforms works on any node", () => {
    const simpleModel = { weight: 8, minKvCache: 2, providers: { ollama: "m" as string | undefined } };
    expect(isDeployableOnCluster(
      [makeNode({ drivers: ["ollama"], gpus: [amdGpu], driverVersions: {} })],
      simpleModel,
    )).toBe(true);
  });
});
