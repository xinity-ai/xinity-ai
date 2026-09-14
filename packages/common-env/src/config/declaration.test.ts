import { expect, test } from "bun:test";
import { z } from "zod";
import { configBool, configInt } from "./leaf-types";
import { defineGroup, env } from "./group";
import { defineConfig, entryFor, groupAt, type ConfigDef } from "./build";

type ObjectStorage = { endpoint: string; accessKeyId: string; bucket: string };
type Server = { host: string; port: number };
type Gateway = { server: Server; s3: ObjectStorage | undefined; origin: string };

const objectStorage = defineGroup<ObjectStorage>({
  id: "s3",
  title: "Object storage",
  optional: { requires: ["endpoint", "accessKeyId"] },
  fields: {
    endpoint: env("S3_ENDPOINT", z.url()),
    accessKeyId: env("S3_ACCESS_KEY_ID", z.string().meta({ secret: true })),
    bucket: env("S3_BUCKET", z.string().default("xinity-media")),
  },
});

const server = defineGroup<Server>({
  id: "server",
  title: "HTTP server",
  fields: {
    host: env("HOST", z.string().default("localhost")),
    port: env("PORT", configInt(z.int().max(65535)).default(4010)),
  },
});

const gateway = defineConfig<Gateway>({
  server,
  s3: objectStorage,
  origin: env("ORIGIN", z.url().describe("Public origin")),
});

test("entries are the full path from the config root, with the group they came from", () => {
  expect(gateway.entries.map((entry) => entry.path.join("."))).toEqual([
    "server.host",
    "server.port",
    "s3.endpoint",
    "s3.accessKeyId",
    "s3.bucket",
    "origin",
  ]);

  const origin = entryFor(gateway, "ORIGIN")!;
  expect(origin.description).toBe("Public origin");
  expect(origin.groupId).toBeUndefined();
  expect(entryFor(gateway, "S3_ACCESS_KEY_ID")!.groupId).toBe("s3");
  expect(entryFor(gateway, "S3_ACCESS_KEY_ID")!.isSecret).toBe(true);
});

test("a mounted group carries its activation keys and a schema built from its own fields", () => {
  expect(groupAt(gateway, "s3")!.activation).toEqual(["S3_ENDPOINT", "S3_ACCESS_KEY_ID"]);
  expect(groupAt(gateway, "server")!.activation).toEqual([]);

  expect(groupAt(gateway, "s3")!.schema.parse({ endpoint: "http://s:8333", accessKeyId: "AKIA" }))
    .toEqual({ endpoint: "http://s:8333", accessKeyId: "AKIA", bucket: "xinity-media" });
});

test("expert cascades from the group, and a field can carry it alone", () => {
  const mixed = defineGroup<{ a: string; b: string }>({
    id: "mixed",
    title: "Mixed",
    fields: { a: env("A", z.string()), b: env("B", z.string().meta({ expert: true })) },
  });
  const allExpert = defineGroup<{ a: string }>({
    id: "all",
    title: "All",
    expert: true,
    fields: { a: env("C", z.string()) },
  });

  const config = defineConfig<{ mixed: { a: string; b: string }; all: { a: string } }>({ mixed, all: allExpert });
  expect(config.entries.map((entry) => `${entry.envKey}:${entry.isExpert}`))
    .toEqual(["A:false", "B:true", "C:true"]);
});

test("a config is rejected at definition time when it cannot work", () => {
  expect(() =>
    defineGroup<{ a: string; b: string }>({
      id: "g",
      title: "G",
      fields: { a: env("SAME", z.string()), b: env("SAME", z.string()) },
    }),
  ).toThrow(/SAME/);

  expect(() =>
    defineGroup<{ a: string }>({
      id: "g",
      title: "G",
      optional: { requires: [] },
      fields: { a: env("A", z.string()) },
    }),
  ).toThrow(/can never activate/);

  expect(() =>
    defineGroup({
      id: "g",
      title: "G",
      optional: { requires: ["nope"] },
      fields: { a: env("A", z.string()) },
    } as never),
  ).toThrow(/not one of its fields/);

  const clashing = defineGroup<{ host: string }>({
    id: "other",
    title: "Other",
    fields: { host: env("HOST", z.string()) },
  });
  expect(() => defineConfig<{ server: Server; other: { host: string } }>({ server, other: clashing }))
    .toThrow(/HOST is read by both server\.host and other\.host/);
});

// Checked by tsc. Not test() cases: there is nothing to assert at runtime.

const typedConfig: ConfigDef<Gateway> = gateway;
void typedConfig;

defineGroup<Server>({
  id: "server",
  title: "HTTP server",
  fields: {
    host: env("HOST", z.string()),
    // @ts-expect-error port is declared number, this schema produces a boolean
    port: env("PORT", configBool()),
  },
});

// @ts-expect-error port is missing
defineGroup<Server>({ id: "server", title: "HTTP server", fields: { host: env("HOST", z.string()) } });

defineGroup<Server>({
  id: "server",
  title: "HTTP server",
  fields: {
    host: env("HOST", z.string()),
    port: env("PORT", configInt()),
    // @ts-expect-error extra is not a key of Server
    extra: env("EXTRA", z.string()),
  },
});

defineGroup<Server>({
  id: "server",
  title: "HTTP server",
  fields: {
    // @ts-expect-error host is declared string, this schema may produce undefined
    host: env("HOST", z.string().optional()),
    port: env("PORT", configInt()),
  },
});

// @ts-expect-error bucket is optional in the declared type, so it cannot be required
defineGroup<{ endpoint: string; bucket?: string }>({
  id: "s3",
  title: "Object storage",
  optional: { requires: ["bucket"] },
  fields: {
    endpoint: env("S3_ENDPOINT", z.url()),
    bucket: env("S3_BUCKET", z.string().optional()),
  },
});

// @ts-expect-error origin is missing
defineConfig<Gateway>({ server, s3: objectStorage });

defineConfig<Gateway>({
  server,
  s3: objectStorage,
  origin: env("ORIGIN", z.url()),
  // @ts-expect-error extra is not a key of Gateway
  extra: env("EXTRA", z.string()),
});

// @ts-expect-error origin is declared string, this leaf produces a number
defineConfig<Gateway>({ server, s3: objectStorage, origin: env("ORIGIN", configInt()) });

// @ts-expect-error s3 is declared ObjectStorage | undefined, but this group is always present
defineConfig<Gateway>({ server, s3: alwaysPresentStorage(), origin: env("ORIGIN", z.url()) });

function alwaysPresentStorage() {
  return defineGroup<ObjectStorage>({
    id: "s3",
    title: "Object storage",
    fields: {
      endpoint: env("S3_ENDPOINT", z.url()),
      accessKeyId: env("S3_ACCESS_KEY_ID", z.string()),
      bucket: env("S3_BUCKET", z.string()),
    },
  });
}
