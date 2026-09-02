import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseEnv } from "../index";
import { configInt } from "./leaf-types";
import { defineGroup, env } from "./group";
import { defineConfig } from "./build";
import { resolveConfig } from "./resolve";
import { toFlatSchema, type ProjectedGroup } from "./flat-projection";

type ObjectStorage = { endpoint: string; accessKeyId: string; bucket: string };
type Server = { host: string; port: number };
type Gateway = { server: Server; s3: ObjectStorage | undefined; origin: string };

const config = defineConfig<Gateway>({
  server: defineGroup<Server>({
    id: "server",
    title: "HTTP server",
    fields: {
      host: env("HOST", z.string().default("localhost")),
      port: env("PORT", configInt(z.int().max(65535)).default(4010)),
    },
  }),
  s3: defineGroup<ObjectStorage>({
    id: "s3",
    title: "Object storage",
    description: "Media for conversations.",
    expert: true,
    optional: { requires: ["endpoint", "accessKeyId"] },
    fields: {
      endpoint: env("S3_ENDPOINT", z.url()),
      accessKeyId: env("S3_ACCESS_KEY_ID", z.string().meta({ secret: true })),
      bucket: env("S3_BUCKET", z.string().default("xinity-media").describe("Bucket for media")),
    },
  }),
  origin: env("ORIGIN", z.url()),
});

const flat = toFlatSchema(config);

test("the shape is keyed by env key", () => {
  expect(Object.keys(flat.shape)).toEqual([
    "HOST",
    "PORT",
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_BUCKET",
    "ORIGIN",
  ]);
});

describe("optionality reproduces what a flat schema has to be", () => {
  test("a deployment with no object storage parses", () => {
    expect(parseEnv(flat, { ORIGIN: "https://x.example" })).toMatchObject({
      HOST: "localhost",
      PORT: 4010,
      S3_BUCKET: "xinity-media",
    });
  });

  test("a defaulted field in an optional group keeps its default rather than being wrapped", () => {
    const parsed = parseEnv(flat, { ORIGIN: "https://x.example" });
    expect(parsed.S3_BUCKET).toBe("xinity-media");
  });

  test("a required field outside an optional group stays required", () => {
    expect(() => parseEnv(flat, {})).toThrow();
  });
});

test("metadata lands on the outer schema, where a consumer reading only that will find it", () => {
  const read = (key: string) => z.globalRegistry.get(flat.shape[key]!) as Record<string, unknown> | undefined;

  expect(read("S3_ACCESS_KEY_ID")!.secret).toBe(true);
  expect(read("S3_BUCKET")!.description).toBe("Bucket for media");
  expect(read("S3_BUCKET")!.expert).toBe(true);
  expect(read("HOST")!.expert).toBeUndefined();

  const group = read("S3_BUCKET")!.group as ProjectedGroup;
  expect(group).toMatchObject({ id: "s3", title: "Object storage", description: "Media for conversations." });
  expect(group.activation).toEqual(["S3_ENDPOINT", "S3_ACCESS_KEY_ID"]);
  expect(read("HOST")!.group).toMatchObject({ id: "server", activation: [] });
  expect(read("ORIGIN")?.group).toBeUndefined();
});

test("the file-form schema does not leak, so the projection still converts", () => {
  const json = z.toJSONSchema(flat, { io: "input" }) as { properties: Record<string, Record<string, unknown>> };
  expect(json.properties.PORT!.fileSchema).toBeUndefined();
});

test("parsing the projection agrees with resolving the declaration", () => {
  const environment = {
    ORIGIN: "https://x.example",
    PORT: "8080",
    S3_ENDPOINT: "http://seaweedfs:8333",
    S3_ACCESS_KEY_ID: "AKIA",
  };

  const projected = parseEnv(flat, environment);
  const { value } = resolveConfig(config, { env: environment });

  expect(projected.PORT).toBe(value.server.port);
  expect(projected.HOST).toBe(value.server.host);
  expect(projected.ORIGIN).toBe(value.origin);
  expect(projected.S3_ENDPOINT).toBe(value.s3!.endpoint);
  expect(projected.S3_BUCKET).toBe(value.s3!.bucket);
});
