import { describe, it, expect } from "bun:test";
import {
  resolveDefaultProvider,
  resolveProvider,
  resolveDriverForProviderModel,
  resolveTagsForDriver,
  resolveAllTags,
  driverHasTag,
  resolveArgsForDriver,
} from "./model-tags";
import type { Model } from "./definitions/model-definition";

/** Minimal model with both providers */
function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    name: "Test Model",
    description: "A test model",
    weight: 10,
    minKvCache: 2,
    registeredAt: "2025-01-01",
    url: "https://example.com",
    entryVersion: "0.1.0",
    providers: { vllm: "org/test-vllm", ollama: "test-ollama" },
    ...overrides,
  };
}

describe("resolveDefaultProvider", () => {
  it("picks vllm first when both providers are present (ProviderEnum order)", () => {
    const m = makeModel();
    const result = resolveDefaultProvider(m);
    expect(result).toEqual({ driver: "vllm", providerModel: "org/test-vllm" });
  });

  it("picks ollama when only ollama is present", () => {
    const m = makeModel({ providers: { ollama: "test-ollama" } });
    const result = resolveDefaultProvider(m);
    expect(result).toEqual({ driver: "ollama", providerModel: "test-ollama" });
  });

  it("returns undefined when no providers have values", () => {
    const m = makeModel({ providers: {} as any });
    expect(resolveDefaultProvider(m)).toBeUndefined();
  });
});

describe("resolveProvider", () => {
  it("returns the provider model for a known driver", () => {
    const m = makeModel();
    expect(resolveProvider(m, "vllm")).toBe("org/test-vllm");
    expect(resolveProvider(m, "ollama")).toBe("test-ollama");
  });

  it("returns undefined for a driver not in the model", () => {
    const m = makeModel({ providers: { vllm: "org/test-vllm" } });
    expect(resolveProvider(m, "ollama")).toBeUndefined();
  });
});

describe("resolveDriverForProviderModel", () => {
  it("finds the correct driver for a known provider model", () => {
    const m = makeModel();
    expect(resolveDriverForProviderModel(m, "org/test-vllm")).toBe("vllm");
    expect(resolveDriverForProviderModel(m, "test-ollama")).toBe("ollama");
  });

  it("returns undefined for an unknown provider model", () => {
    const m = makeModel();
    expect(resolveDriverForProviderModel(m, "unknown-model")).toBeUndefined();
  });
});

describe("resolveTagsForDriver", () => {
  it("uses providerTags when present for the driver", () => {
    const m = makeModel({
      tags: ["vision"],
      providerTags: { vllm: ["tools", "custom_code"], ollama: ["tools"] },
    });
    expect(resolveTagsForDriver(m, "vllm")).toEqual(["tools", "custom_code"]);
    expect(resolveTagsForDriver(m, "ollama")).toEqual(["tools"]);
  });

  it("falls back to model-level tags when providerTags is absent for the driver", () => {
    const m = makeModel({
      tags: ["vision", "tools"],
      providerTags: { vllm: ["custom_code"] },
    });
    expect(resolveTagsForDriver(m, "ollama")).toEqual(["vision", "tools"]);
  });

  it("returns empty array when neither providerTags nor tags exist", () => {
    const m = makeModel({ tags: undefined, providerTags: undefined });
    expect(resolveTagsForDriver(m, "vllm")).toEqual([]);
  });
});

describe("resolveAllTags", () => {
  it("returns model-level tags when no providerTags exist", () => {
    const m = makeModel({ tags: ["tools", "vision"] });
    expect(resolveAllTags(m)).toEqual(["tools", "vision"]);
  });

  it("returns empty array when no tags at all", () => {
    const m = makeModel({ tags: undefined, providerTags: undefined });
    expect(resolveAllTags(m)).toEqual([]);
  });

  it("returns union of model-level and all driver-specific tags, deduplicated", () => {
    const m = makeModel({
      tags: ["vision"],
      providerTags: { vllm: ["tools", "vision"], ollama: ["custom_code"] },
    });
    const tags = resolveAllTags(m);
    expect(tags).toContain("vision");
    expect(tags).toContain("tools");
    expect(tags).toContain("custom_code");
    // No duplicates
    expect(tags.filter(t => t === "vision")).toHaveLength(1);
  });
});

describe("driverHasTag", () => {
  it("returns true when the driver has the tag", () => {
    const m = makeModel({ providerTags: { vllm: ["tools"] } });
    expect(driverHasTag(m, "vllm", "tools")).toBe(true);
  });

  it("returns false when the driver does not have the tag", () => {
    const m = makeModel({ providerTags: { vllm: ["tools"] } });
    expect(driverHasTag(m, "vllm", "custom_code")).toBe(false);
  });

  it("falls back to model-level tags for a driver without providerTags", () => {
    const m = makeModel({ tags: ["vision"], providerTags: { vllm: ["tools"] } });
    expect(driverHasTag(m, "ollama", "vision")).toBe(true);
  });
});

describe("resolveArgsForDriver", () => {
  it("returns driver-specific args when present", () => {
    const m = makeModel({
      providerArgs: { vllm: ["--max-model-len", "4096"] },
    });
    expect(resolveArgsForDriver(m, "vllm")).toEqual(["--max-model-len", "4096"]);
  });

  it("returns empty array when providerArgs is absent", () => {
    const m = makeModel();
    expect(resolveArgsForDriver(m, "vllm")).toEqual([]);
  });

  it("returns empty array when driver has no args entry", () => {
    const m = makeModel({ providerArgs: { vllm: ["--some-arg"] } });
    expect(resolveArgsForDriver(m, "ollama")).toEqual([]);
  });
});
