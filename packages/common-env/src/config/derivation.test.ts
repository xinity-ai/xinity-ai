import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { configInt, configList } from "./leaf-types";
import { defineGroup, dynamic, env } from "./group";
import { defineConfig } from "./build";
import { createDynamicConfig, type ApplyOverrides, type ConfigFeed } from "./dynamic-config";

type Cache = { url: string; responseTtlSeconds: () => number; modelTtlSeconds: () => number };
type Service = { cache: Cache; origins: () => string[] };

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
  origins: dynamic("TRUSTED_ORIGINS", configList(z.string()).default([])),
});

const BASE = {
  REDIS_URL: "redis://localhost:6379",
  RESPONSE_CACHE_TTL_SECONDS: "@dynamic",
  CACHE_MODEL_TTL_SECONDS: "@dynamic",
  TRUSTED_ORIGINS: "@dynamic:a.example",
};

async function startFed() {
  let push: ApplyOverrides = () => [];
  const feed: ConfigFeed = async (apply) => {
    push = apply;
    return async () => {};
  };

  const config = createDynamicConfig({ declaration, rawEnv: BASE, feed });
  await config.start();
  return { config, push: (overrides: Record<string, string>) => push(overrides) };
}

describe("derive", () => {
  test("builds on first read and caches until a selected input changes", async () => {
    const { config, push } = await startFed();
    let builds = 0;
    const client = config.derive(
      (value) => value.cache.responseTtlSeconds(),
      (ttl) => {
        builds += 1;
        return `client:${ttl}`;
      },
    );

    expect(builds).toBe(0);
    expect(client.get()).toBe("client:3600");
    expect(client.get()).toBe("client:3600");
    expect(builds).toBe(1);

    push({ CACHE_MODEL_TTL_SECONDS: "5" });
    client.get();
    expect(builds).toBe(1);

    push({ CACHE_MODEL_TTL_SECONDS: "5", RESPONSE_CACHE_TTL_SECONDS: "60" });
    expect(client.get()).toBe("client:60");
  });

  test("compares a re-parsed list by its contents, not its identity", async () => {
    const { config, push } = await startFed();
    let builds = 0;
    const client = config.derive(
      (value) => value.origins(),
      (origins) => {
        builds += 1;
        return origins.join("|");
      },
    );
    client.get();

    push({ RESPONSE_CACHE_TTL_SECONDS: "60" });
    expect(builds).toBe(1);

    push({ TRUSTED_ORIGINS: "a.example,b.example" });
    expect(client.get()).toBe("a.example|b.example");
  });

  test("subscribe delivers the current value and every later one", async () => {
    const { config, push } = await startFed();
    const seen: number[] = [];
    config
      .derive((value) => value.cache.responseTtlSeconds(), (ttl) => ttl)
      .subscribe((ttl) => seen.push(ttl));

    push({ RESPONSE_CACHE_TTL_SECONDS: "60" });
    push({ RESPONSE_CACHE_TTL_SECONDS: "120" });

    expect(seen).toEqual([3600, 60, 120]);
  });

  test("stays quiet when an input moved but the built value did not", async () => {
    const { config, push } = await startFed();
    const seen: string[] = [];
    config
      .derive(
        (value) => value.cache.responseTtlSeconds(),
        (ttl) => (ttl > 100 ? "long" : "short"),
      )
      .subscribe((band) => seen.push(band));

    push({ RESPONSE_CACHE_TTL_SECONDS: "200" });
    expect(seen).toEqual(["long"]);

    push({ RESPONSE_CACHE_TTL_SECONDS: "60" });
    expect(seen).toEqual(["long", "short"]);
  });

  test("disposes the value it replaces, even when the teardown throws", async () => {
    const { config, push } = await startFed();
    const closed: string[] = [];
    const client = config.derive(
      (value) => value.cache.responseTtlSeconds(),
      (ttl) => `client:${ttl}`,
      {
        dispose: (value) => {
          closed.push(value);
          throw new Error("close failed");
        },
      },
    );
    client.get();

    push({ RESPONSE_CACHE_TTL_SECONDS: "60" });
    expect(closed).toEqual(["client:3600"]);
    expect(client.get()).toBe("client:60");
  });

  test("a build that throws neither breaks the update nor discards the old value", async () => {
    const { config, push } = await startFed();
    const closed: string[] = [];
    let failing = false;
    const client = config.derive(
      (value) => value.cache.responseTtlSeconds(),
      (ttl) => {
        if (failing) {
          throw new Error("cannot build");
        }
        return `client:${ttl}`;
      },
      { dispose: (value) => closed.push(value) },
    );
    client.subscribe(() => {});

    failing = true;
    expect(push({ RESPONSE_CACHE_TTL_SECONDS: "60" })).toEqual(["cache.responseTtlSeconds"]);
    expect(closed).toEqual([]);
    expect(() => client.get()).toThrow(/cannot build/);

    failing = false;
    expect(client.get()).toBe("client:60");
  });

  test("a derivation selecting another one rebuilds behind it", async () => {
    const { config, push } = await startFed();
    const inner = config.derive(
      (value) => value.cache.responseTtlSeconds(),
      (ttl) => `client:${ttl}`,
    );
    const outer = config.derive(() => inner.get(), (client) => `pool(${client})`);
    expect(outer.get()).toBe("pool(client:3600)");

    push({ RESPONSE_CACHE_TTL_SECONDS: "60" });
    expect(outer.get()).toBe("pool(client:60)");
  });
});
