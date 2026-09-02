import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { configInt, configList } from "./leaf-types";
import { defineGroup, env } from "./group";
import { defineConfig } from "./build";
import { toConfigJsonSchema } from "./json-schema";

type ObjectStorage = { endpoint: string; accessKeyId: string; bucket: string };
type Server = { host: string; port: number; idleTimeout: number };
type Logging = { level: "info" | "debug"; extra: string[] };
type Gateway = { server: Server; s3: ObjectStorage | undefined; log: Logging; origin: string };

const config = defineConfig<Gateway>({
  server: defineGroup<Server>({
    id: "server",
    title: "HTTP server",
    description: "Where the gateway listens.",
    fields: {
      host: env("HOST", z.string().default("localhost")),
      port: env("PORT", configInt(z.int().max(65535)).default(4010)),
      idleTimeout: env("IDLE_TIMEOUT", configInt(z.int().max(255)).default(255).describe("Seconds")),
    },
  }),
  s3: defineGroup<ObjectStorage>({
    id: "s3",
    title: "Object storage",
    expert: true,
    optional: { requires: ["endpoint", "accessKeyId"] },
    fields: {
      endpoint: env("S3_ENDPOINT", z.url()),
      accessKeyId: env("S3_ACCESS_KEY_ID", z.string().meta({ secret: true })),
      bucket: env("S3_BUCKET", z.string().default("xinity-media")),
    },
  }),
  log: defineGroup<Logging>({
    id: "log",
    title: "Logging",
    fields: {
      level: env("LOG_LEVEL", z.enum(["info", "debug"]).default("info")),
      extra: env("LOG_EXTRA", configList(z.string()).default([])),
    },
  }),
  origin: env("ORIGIN", z.url()),
});

const schema = toConfigJsonSchema(config, { id: "gateway.json", title: "Gateway" }) as Record<string, any>;

describe("leaves describe the config file form", () => {
  test("a dual leaf is its native type, not an anyOf over both branches", () => {
    expect(schema.properties.server.properties.port).toMatchObject({ type: "integer", default: 4010 });
    expect(schema.properties.server.properties.port.anyOf).toBeUndefined();
  });

  test("bounds and enum members survive, safe-integer noise does not", () => {
    expect(schema.properties.server.properties.idleTimeout).toMatchObject({ maximum: 255 });
    expect(schema.properties.server.properties.idleTimeout.minimum).toBeUndefined();
    expect(schema.properties.log.properties.level).toMatchObject({ enum: ["info", "debug"], default: "info" });
  });

  test("our own markers never leak into the output", () => {
    const key = schema.properties.s3.properties.accessKeyId;
    for (const marker of ["secret", "expert", "public", "fileSchema", "$schema"]) {
      expect(key[marker]).toBeUndefined();
    }
    expect(key.description).toContain("prefer S3_ACCESS_KEY_ID_FILE");
  });
});

describe("required", () => {
  test("a leaf without a default is required, one with a default is not", () => {
    expect(schema.properties.s3.required).toEqual(["endpoint", "accessKeyId"]);
    expect(schema.properties.server.required).toBeUndefined();
  });

  test("an optional group is never required at the root, a mandatory one with gaps is", () => {
    expect(schema.required).toEqual(["origin"]);
    expect(schema.required).not.toContain("s3");
  });
});

test("unknown keys are refused at every level, which is what makes a typo visible", () => {
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.server.additionalProperties).toBe(false);
  expect(schema.properties.s3.additionalProperties).toBe(false);
});
