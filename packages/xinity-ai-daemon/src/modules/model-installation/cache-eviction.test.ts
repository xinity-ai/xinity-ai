import { describe, test, expect, mock } from "bun:test";
import type { ModelInstallation } from "common-db";

mock.module("../../env", () => ({ env: { VLLM_HF_CACHE_DIR: "/tmp/test" } }));
mock.module("../../logger", () => ({
  rootLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

import { planEviction, slugForModel, modelForSlug, type CacheEntry } from "./cache-eviction";

const GB = 1024 ** 3;

function entry(model: string, sizeGb: number, mtime: Date = new Date()): CacheEntry {
  return {
    slug: slugForModel(model),
    model,
    dir: `/cache/hub/${slugForModel(model)}`,
    sizeBytes: sizeGb * GB,
    mtime,
  };
}

function inst(model: string, opts: { deletedAt?: Date | null } = {}): ModelInstallation {
  return {
    id: crypto.randomUUID(),
    nodeId: "node-1",
    model,
    estCapacity: 16,
    kvCacheCapacity: 4,
    port: 8080,
    driver: "vllm",
    deletedAt: opts.deletedAt ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("slug round-trip", () => {
  test("simple org/name", () => {
    expect(slugForModel("meta-llama/Llama-3.1-8B")).toBe("models--meta-llama--Llama-3.1-8B");
    expect(modelForSlug("models--meta-llama--Llama-3.1-8B")).toBe("meta-llama/Llama-3.1-8B");
  });

  test("name with dashes survives round-trip", () => {
    expect(modelForSlug(slugForModel("mistralai/Mistral-7B-Instruct-v0.3"))).toBe(
      "mistralai/Mistral-7B-Instruct-v0.3",
    );
  });
});

describe("planEviction - no-op cases", () => {
  test("does nothing when free space already exceeds required + safety margin", () => {
    const plan = planEviction({
      entries: [entry("foo/bar", 50)],
      installations: [],
      requiredBytes: 10 * GB,
      reservedModel: "new/model",
      freeBytes: 100 * GB,
      safetyMarginBytes: GB,
    });
    expect(plan.evict).toEqual([]);
    expect(plan.sufficient).toBe(true);
  });
});

describe("planEviction - active installations are protected", () => {
  test("never evicts cache for an active installation", () => {
    const entries = [entry("active/model", 80), entry("orphan/model", 80)];
    const installations = [inst("active/model")];
    const plan = planEviction({
      entries,
      installations,
      requiredBytes: 50 * GB,
      reservedModel: "new/model",
      freeBytes: 5 * GB,
    });
    expect(plan.evict.map((e) => e.model)).toEqual(["orphan/model"]);
    expect(plan.sufficient).toBe(true);
  });
});

describe("planEviction - reservedModel is skipped", () => {
  test("never evicts the cache dir of the model we're about to download", () => {
    const entries = [entry("being/downloaded", 50)];
    const installations = [inst("being/downloaded", { deletedAt: new Date(2020, 0) })];
    const plan = planEviction({
      entries,
      installations,
      requiredBytes: 30 * GB,
      reservedModel: "being/downloaded",
      freeBytes: 1 * GB,
    });
    expect(plan.evict).toEqual([]);
    expect(plan.sufficient).toBe(false);
  });
});

describe("planEviction - ordering", () => {
  test("oldest deletedAt evicts first", () => {
    const entries = [
      entry("recent/del", 20),
      entry("ancient/del", 20),
      entry("middle/del", 20),
    ];
    const installations = [
      inst("recent/del", { deletedAt: new Date(2026, 4, 1) }),
      inst("ancient/del", { deletedAt: new Date(2024, 0, 1) }),
      inst("middle/del", { deletedAt: new Date(2025, 5, 1) }),
    ];
    const plan = planEviction({
      entries,
      installations,
      requiredBytes: 35 * GB,
      reservedModel: "new/model",
      freeBytes: 0,
      safetyMarginBytes: 0,
    });
    expect(plan.evict.map((e) => e.model)).toEqual(["ancient/del", "middle/del"]);
  });

  test("orphaned cache (no DB row) ranks by mtime ascending", () => {
    const entries = [
      entry("orphan/young", 20, new Date(2026, 0)),
      entry("orphan/old", 20, new Date(2024, 0)),
    ];
    const plan = planEviction({
      entries,
      installations: [],
      requiredBytes: 15 * GB,
      reservedModel: "new/model",
      freeBytes: 0,
      safetyMarginBytes: 0,
    });
    expect(plan.evict.map((e) => e.model)).toEqual(["orphan/old"]);
  });

  test("uses most recent deletedAt when an installation has multiple deleted rows", () => {
    const entries = [entry("foo/bar", 20)];
    const installations = [
      inst("foo/bar", { deletedAt: new Date(2024, 0) }),
      inst("foo/bar", { deletedAt: new Date(2026, 0) }),
    ];
    const plan = planEviction({
      entries: [entry("baz/qux", 20, new Date(2025, 0)), ...entries],
      installations,
      requiredBytes: 15 * GB,
      reservedModel: "new/model",
      freeBytes: 0,
      safetyMarginBytes: 0,
    });
    expect(plan.evict.map((e) => e.model)).toEqual(["baz/qux"]);
  });
});

describe("planEviction - stop conditions", () => {
  test("stops once enough has been freed", () => {
    const entries = [
      entry("a/del", 50, new Date(2024, 0)),
      entry("b/del", 50, new Date(2025, 0)),
      entry("c/del", 50, new Date(2026, 0)),
    ];
    const installations = [
      inst("a/del", { deletedAt: new Date(2024, 0) }),
      inst("b/del", { deletedAt: new Date(2025, 0) }),
      inst("c/del", { deletedAt: new Date(2026, 0) }),
    ];
    const plan = planEviction({
      entries,
      installations,
      requiredBytes: 60 * GB,
      reservedModel: "new/model",
      freeBytes: 0,
      safetyMarginBytes: 0,
    });
    expect(plan.evict.map((e) => e.model)).toEqual(["a/del", "b/del"]);
    expect(plan.freedBytes).toBe(100 * GB);
  });

  test("reports insufficient when no candidates can free enough", () => {
    const entries = [entry("tiny/del", 1)];
    const installations = [inst("tiny/del", { deletedAt: new Date(2020, 0) })];
    const plan = planEviction({
      entries,
      installations,
      requiredBytes: 100 * GB,
      reservedModel: "new/model",
      freeBytes: 0,
      safetyMarginBytes: 0,
    });
    expect(plan.sufficient).toBe(false);
    expect(plan.evict.map((e) => e.model)).toEqual(["tiny/del"]);
  });
});

describe("planEviction - safety margin", () => {
  test("safety margin is respected on top of required", () => {
    const entries = [entry("a/del", 5, new Date(2024, 0))];
    const installations = [inst("a/del", { deletedAt: new Date(2024, 0) })];
    const plan = planEviction({
      entries,
      installations,
      requiredBytes: 10 * GB,
      reservedModel: "new/model",
      freeBytes: 11 * GB,
      safetyMarginBytes: 2 * GB,
    });
    // Have 11G free, need 10+2=12G → must evict the 5G entry → 16G free.
    expect(plan.evict.map((e) => e.model)).toEqual(["a/del"]);
    expect(plan.sufficient).toBe(true);
  });
});
