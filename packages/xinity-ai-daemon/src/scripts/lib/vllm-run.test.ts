import { describe, test, expect } from "bun:test";
import {
  resolveVllmModel,
  findVllmModel,
  checkVllmCompatibility,
  RunModelError,
  type MachineProfile,
} from "./vllm-run";

const baseModel = {
  name: "Test",
  description: "test model",
  weight: 16,
  minKvCache: 8,
  url: "https://example.com",
  type: "chat" as const,
  providers: { vllm: "org/test-model" },
};

const file = (models: Record<string, any>) => ({ models });

const nvidia24: MachineProfile = {
  gpus: [{ vendor: "nvidia", name: "RTX 4090", vramMb: 24576 }],
  detectedCapacityGb: 24,
};

describe("findVllmModel", () => {
  test("resolves by public specifier", () => {
    const found = findVllmModel(file({ "test-model": baseModel }), "test-model");
    expect(found.vllmProviderName).toBe("org/test-model");
  });

  test("resolves by providers.vllm value", () => {
    const found = findVllmModel(file({ "test-model": baseModel }), "org/test-model");
    expect(found.vllmProviderName).toBe("org/test-model");
  });

  test("throws when the entry has no vllm provider", () => {
    const ollamaOnly = { ...baseModel, providers: { ollama: "test:7b" } };
    expect(() => findVllmModel(file({ x: ollamaOnly }), "x")).toThrow(RunModelError);
  });

  test("throws for an unknown name", () => {
    expect(() => findVllmModel(file({ "test-model": baseModel }), "nope")).toThrow(RunModelError);
  });
});

describe("resolveVllmModel", () => {
  test("derives tags, kvCache floor and estCapacity", () => {
    const tagged = { ...baseModel, tags: ["custom_code", "tools"] };
    const r = resolveVllmModel(file({ "test-model": tagged }), "test-model");
    expect(r.trustRemoteCode).toBe(true);
    expect(r.hasToolsTag).toBe(true);
    expect(r.kvCacheGb).toBe(8);
    expect(r.estCapacity).toBe(24);
  });

  test("kvCache override raises the floor but never lowers it", () => {
    const above = resolveVllmModel(file({ m: baseModel }), "m", { kvCacheGbOverride: 12 });
    expect(above.kvCacheGb).toBe(12);
    expect(above.estCapacity).toBe(28);

    const below = resolveVllmModel(file({ m: baseModel }), "m", { kvCacheGbOverride: 4 });
    expect(below.kvCacheGb).toBe(8);
  });
});

describe("checkVllmCompatibility", () => {
  test("passes when version, platform and capacity are satisfied", () => {
    const r = resolveVllmModel(file({ m: { ...baseModel, providerMinVersions: { vllm: "0.6.0" } } }), "m");
    const reason = checkVllmCompatibility(r, nvidia24, { available: true, version: "0.19.1" });
    expect(reason).toBeNull();
  });

  test("flags version_too_old", () => {
    const r = resolveVllmModel(file({ m: { ...baseModel, providerMinVersions: { vllm: "0.20.0" } } }), "m");
    const reason = checkVllmCompatibility(r, nvidia24, { available: true, version: "0.19.1" });
    expect(reason).toBe("version_too_old");
  });

  test("flags version_unknown only when requireKnownVersion is set", () => {
    const r = resolveVllmModel(file({ m: { ...baseModel, providerMinVersions: { vllm: "0.6.0" } } }), "m");
    expect(checkVllmCompatibility(r, nvidia24, { available: true })).toBeNull();
    expect(checkVllmCompatibility(r, nvidia24, { available: true }, { requireKnownVersion: true })).toBe("version_unknown");
  });

  test("flags missing_driver when the driver is unavailable", () => {
    const r = resolveVllmModel(file({ m: baseModel }), "m");
    expect(checkVllmCompatibility(r, nvidia24, { available: false })).toBe("missing_driver");
  });

  test("flags wrong_platform when the GPU vendor does not match", () => {
    const r = resolveVllmModel(file({ m: { ...baseModel, providerPlatforms: { vllm: ["amd"] } } }), "m");
    expect(checkVllmCompatibility(r, nvidia24, { available: true, version: "0.19.1" })).toBe("wrong_platform");
  });

  test("flags insufficient_capacity when the model is too large", () => {
    const r = resolveVllmModel(file({ m: { ...baseModel, weight: 40 } }), "m");
    expect(checkVllmCompatibility(r, nvidia24, { available: true, version: "0.19.1" })).toBe("insufficient_capacity");
  });
});
