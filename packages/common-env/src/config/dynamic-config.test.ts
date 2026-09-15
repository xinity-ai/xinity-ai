import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { configInt } from "./leaf-types";
import { defineGroup, dynamic, env } from "./group";
import { defineConfig } from "./build";
import { resolveConfig } from "./resolve";
import { createDynamicConfig, type ApplyOverrides, type ConfigFeed } from "./dynamic-config";

type Cache = { url: string; responseTtlSeconds: () => number; modelTtlSeconds: () => number };
type Inference = { strategy: () => "random" | "least-connections"; timeoutMs: number };
type ObjectStorage = { endpoint: string; bucket: () => string };

type Service = {
  cache: Cache;
  inference: Inference;
  s3: ObjectStorage | undefined;
  origin: string;
};

const declaration = defineConfig<Service>({
  cache: defineGroup<Cache>({
    id: "cache",
    title: "Cache",
    fields: {
      url: env("REDIS_URL", z.url()),
      responseTtlSeconds: dynamic("RESPONSE_CACHE_TTL_SECONDS", configInt(z.int().positive()).default(3600)),
      modelTtlSeconds: dynamic("CACHE_MODEL_TTL_SECONDS", configInt(z.int().positive()).default(60)),
    },
  }),
  inference: defineGroup<Inference>({
    id: "inference",
    title: "Inference backends",
    fields: {
      strategy: dynamic("LOAD_BALANCE_STRATEGY", z.enum(["random", "least-connections"]).default("least-connections")),
      timeoutMs: env("BACKEND_TIMEOUT_MS", configInt(z.int().positive()).default(300_000)),
    },
  }),
  s3: defineGroup<ObjectStorage>({
    id: "s3",
    title: "Object storage",
    optional: { requires: ["endpoint"] },
    fields: {
      endpoint: env("S3_ENDPOINT", z.url()),
      bucket: dynamic("S3_BUCKET", z.string().default("xinity-media")),
    },
  }),
  origin: env("ORIGIN", z.url()),
});

const BASE = { REDIS_URL: "redis://localhost:6379", ORIGIN: "https://x.example" };

function startFed(rawEnv: Record<string, string | undefined>) {
  let push: ApplyOverrides = () => [];
  const feed: ConfigFeed = async (apply) => {
    push = apply;
    return async () => {};
  };

  const config = createDynamicConfig({ declaration, rawEnv, feed });
  return {
    config,
    started: config.start(),
    push: (overrides: Record<string, string>) => push(overrides),
  };
}

describe("dynamic leaves", () => {
  test("resolve to an accessor on the static path too, so one declaration has one shape", () => {
    const { value } = resolveConfig(declaration, { env: BASE });

    expect(value.cache.responseTtlSeconds()).toBe(3600);
    expect(value.inference.timeoutMs).toBe(300_000);
  });

  test("an accessor captured before a change still reads the current value", async () => {
    const { config, started, push } = startFed({ ...BASE, RESPONSE_CACHE_TTL_SECONDS: "@dynamic" });
    await started;
    const responseTtl = config.value.cache.responseTtlSeconds;

    push({ RESPONSE_CACHE_TTL_SECONDS: "60" });
    expect(responseTtl()).toBe(60);
  });
});

describe("delegation at boot", () => {
  test("falls back to the schema default when the sentinel carries no fallback", () => {
    const config = createDynamicConfig({
      declaration,
      rawEnv: { ...BASE, RESPONSE_CACHE_TTL_SECONDS: "@dynamic" },
    });

    expect(config.value.cache.responseTtlSeconds()).toBe(3600);
    expect(config.delegatedKeys).toEqual(["RESPONSE_CACHE_TTL_SECONDS"]);
  });

  test("parses the sentinel fallback exactly like a literal value", () => {
    const config = createDynamicConfig({
      declaration,
      rawEnv: { ...BASE, RESPONSE_CACHE_TTL_SECONDS: "@dynamic:120" },
    });

    expect(config.value.cache.responseTtlSeconds()).toBe(120);
  });

  test("ignores a _FILE companion for a delegated key, so no override means the fallback", () => {
    const config = createDynamicConfig({
      declaration,
      rawEnv: {
        ...BASE,
        RESPONSE_CACHE_TTL_SECONDS: "@dynamic",
        RESPONSE_CACHE_TTL_SECONDS_FILE: "/nonexistent",
      },
    });

    expect(config.value.cache.responseTtlSeconds()).toBe(3600);
  });

  test("rejects a key that is not declared dynamic, naming the ones that are", () => {
    expect(() => createDynamicConfig({
      declaration,
      rawEnv: { ...BASE, BACKEND_TIMEOUT_MS: "@dynamic" },
    })).toThrow(/BACKEND_TIMEOUT_MS is not declared dynamic.*RESPONSE_CACHE_TTL_SECONDS/s);
  });

  test("rejects delegating a key that decides group activation", () => {
    type Storage = { endpoint: () => string; bucket: string };
    const withDynamicActivation = defineConfig<{ s3: Storage | undefined }>({
      s3: defineGroup<Storage>({
        id: "s3",
        title: "Object storage",
        optional: { requires: ["endpoint"] },
        fields: {
          endpoint: dynamic("S3_ENDPOINT", z.url()),
          bucket: env("S3_BUCKET", z.string().default("xinity-media")),
        },
      }),
    });

    expect(() => createDynamicConfig({
      declaration: withDynamicActivation,
      rawEnv: { S3_ENDPOINT: "@dynamic:http://objects.internal:8333" },
    })).toThrow(/S3_ENDPOINT decides whether its group is active/);
  });

  test("rejects a fallback the schema refuses", () => {
    expect(() => createDynamicConfig({
      declaration,
      rawEnv: { ...BASE, RESPONSE_CACHE_TTL_SECONDS: "@dynamic:-5" },
    })).toThrow(/RESPONSE_CACHE_TTL_SECONDS/);
  });
});

describe("applying overrides", () => {
  test("adopts an override and reports the pointer that moved", async () => {
    const { config, started, push } = startFed({ ...BASE, RESPONSE_CACHE_TTL_SECONDS: "@dynamic" });
    await started;

    expect(push({ RESPONSE_CACHE_TTL_SECONDS: "60" })).toEqual(["cache.responseTtlSeconds"]);
    expect(config.value.cache.responseTtlSeconds()).toBe(60);
  });

  test("ignores overrides for keys this process has not delegated", async () => {
    const { config, started, push } = startFed({ ...BASE, RESPONSE_CACHE_TTL_SECONDS: "@dynamic" });
    await started;

    expect(push({ CACHE_MODEL_TTL_SECONDS: "5", BACKEND_TIMEOUT_MS: "1" })).toEqual([]);
    expect(config.value.cache.modelTtlSeconds()).toBe(60);
    expect(config.value.inference.timeoutMs).toBe(300_000);
  });

  test("returns to the fallback when an override is withdrawn", async () => {
    const { config, started, push } = startFed({ ...BASE, RESPONSE_CACHE_TTL_SECONDS: "@dynamic:120" });
    await started;

    push({ RESPONSE_CACHE_TTL_SECONDS: "60" });
    expect(push({})).toEqual(["cache.responseTtlSeconds"]);
    expect(config.value.cache.responseTtlSeconds()).toBe(120);
  });

  test("keeps the previous values when an override fails validation", async () => {
    const { config, started, push } = startFed({ ...BASE, RESPONSE_CACHE_TTL_SECONDS: "@dynamic:120" });
    await started;

    expect(() => push({ RESPONSE_CACHE_TTL_SECONDS: "-5" })).toThrow(/RESPONSE_CACHE_TTL_SECONDS/);
    expect(config.value.cache.responseTtlSeconds()).toBe(120);
  });

  test("a dynamic field inside an active optional group follows its overrides", async () => {
    const { config, started, push } = startFed({
      ...BASE,
      S3_ENDPOINT: "http://objects.internal:8333",
      S3_BUCKET: "@dynamic",
    });
    await started;

    expect(config.value.s3?.bucket()).toBe("xinity-media");
    push({ S3_BUCKET: "other" });
    expect(config.value.s3?.bucket()).toBe("other");
  });

  test("calls a value dynamic only while an override supplies it", async () => {
    const { config, started, push } = startFed({ ...BASE, RESPONSE_CACHE_TTL_SECONDS: "@dynamic:120" });
    await started;
    const sourceOf = (pointer: string) =>
      config.provenance().find((entry) => entry.pointer === pointer)?.source;

    expect(sourceOf("cache.responseTtlSeconds")).toBe("env");

    push({ RESPONSE_CACHE_TTL_SECONDS: "60" });
    expect(sourceOf("cache.responseTtlSeconds")).toBe("dynamic");

    push({});
    expect(sourceOf("cache.responseTtlSeconds")).toBe("env");
  });
});

describe("the feed", () => {
  test("is the only way in, and is torn down on stop", async () => {
    let teardowns = 0;
    const feed: ConfigFeed = async () => async () => {
      teardowns += 1;
    };
    const config = createDynamicConfig({ declaration, rawEnv: BASE, feed });

    await config.start();
    await config.stop();
    expect(teardowns).toBe(1);
  });
});
