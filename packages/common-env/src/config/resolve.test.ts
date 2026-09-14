import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { configInt } from "./leaf-types";
import { defineGroup, env } from "./group";
import { defineConfig } from "./build";
import { checkConfig, resolveConfig } from "./resolve";

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
    optional: { requires: ["endpoint", "accessKeyId"] },
    fields: {
      endpoint: env("S3_ENDPOINT", z.url()),
      accessKeyId: env("S3_ACCESS_KEY_ID", z.string().meta({ secret: true })),
      bucket: env("S3_BUCKET", z.string().default("xinity-media")),
    },
  }),
  origin: env("ORIGIN", z.url()),
});

const ORIGIN = { ORIGIN: "https://x.example" };
const S3_ON = { S3_ENDPOINT: "http://objects.internal:8333", S3_ACCESS_KEY_ID: "AKIA" };

const scratch = () => mkdtempSync(join(tmpdir(), "xinity-config-"));

describe("optional groups", () => {
  test("inactive resolves to undefined and never parses its fields", () => {
    const { value } = resolveConfig(config, { env: { ...ORIGIN, S3_BUCKET: "not-a-trigger" } });
    expect(value.s3).toBeUndefined();
  });

  test("active parses its fields and applies their defaults", () => {
    const { value } = resolveConfig(config, { env: { ...ORIGIN, ...S3_ON } });
    expect(value.s3).toEqual({
      endpoint: "http://objects.internal:8333",
      accessKeyId: "AKIA",
      bucket: "xinity-media",
    });
  });

  test("partial resolves to undefined and warns, rather than failing the boot", () => {
    const { value, warnings } = resolveConfig(config, {
      env: { ...ORIGIN, S3_ENDPOINT: "http://objects.internal:8333" },
    });
    expect(value.s3).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.missing).toEqual(["S3_ACCESS_KEY_ID"]);
  });

  test("an active group with a bad value fails, rather than falling back to inactive", () => {
    expect(() => resolveConfig(config, { env: { ...ORIGIN, ...S3_ON, S3_ENDPOINT: "not-a-url" } }))
      .toThrow(/S3_ENDPOINT \(s3\.endpoint\)/);
  });
});

describe("precedence", () => {
  test("a direct env var beats KEY_FILE", () => {
    const dir = scratch();
    const path = join(dir, "origin");
    writeFileSync(path, "https://from-file.example\n");

    const { value } = resolveConfig(config, {
      env: { ...ORIGIN, ORIGIN_FILE: path, ...S3_ON },
    });
    expect(value.origin).toBe("https://x.example");
    expect(resolveConfig(config, { env: { ORIGIN_FILE: path, ...S3_ON } }).value.origin)
      .toBe("https://from-file.example");
  });

});

describe("KEY_FILE is the only indirection", () => {
  test("its contents become the value, trimmed", () => {
    const path = join(scratch(), "s3-key");
    writeFileSync(path, "AKIA-FROM-FILE\n");

    const { value } = resolveConfig(config, {
      env: { ...ORIGIN, S3_ENDPOINT: "http://s:8333", S3_ACCESS_KEY_ID_FILE: path },
    });
    expect(value.s3?.accessKeyId).toBe("AKIA-FROM-FILE");
  });

  test("it counts for activation, so a group configured entirely through it is active", () => {
    const dir = scratch();
    writeFileSync(join(dir, "endpoint"), "http://s:8333\n");
    writeFileSync(join(dir, "key"), "AKIA\n");

    const { value, warnings } = resolveConfig(config, {
      env: {
        ...ORIGIN,
        S3_ENDPOINT_FILE: join(dir, "endpoint"),
        S3_ACCESS_KEY_ID_FILE: join(dir, "key"),
      },
    });
    expect(warnings).toEqual([]);
    expect(value.s3?.accessKeyId).toBe("AKIA");
  });

  test("pointing at a file that is not there names the key", () => {
    expect(() =>
      resolveConfig(config, {
        env: { ...ORIGIN, S3_ENDPOINT: "http://s:8333", S3_ACCESS_KEY_ID_FILE: "/nope/missing" },
      }),
    ).toThrow(/secret file for S3_ACCESS_KEY_ID/);
  });
});

test("every problem is reported at once, against the env key the operator set", () => {
  const failure = (() => {
    try {
      resolveConfig(config, { env: { ORIGIN: "not-a-url", ...S3_ON, PORT: "99999" } });
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  })();

  expect(failure).toContain("PORT (server.port)");
  expect(failure).toContain("ORIGIN (origin)");
});

test("provenance says where each value came from", () => {
  const path = join(scratch(), "s3-key");
  writeFileSync(path, "AKIA-FROM-FILE\n");

  const { provenance } = resolveConfig(config, {
    env: { ...ORIGIN, ...S3_ON, S3_ACCESS_KEY_ID: "", S3_ACCESS_KEY_ID_FILE: path },
  });
  const at = (pointer: string) => provenance.find((entry) => entry.pointer === pointer)!;

  expect(at("origin").source).toBe("env");
  expect(at("s3.accessKeyId").source).toBe("env-file");
  expect(at("server.port").source).toBe("default");
  expect(at("s3.accessKeyId").isSecret).toBe(true);
});

describe("checkConfig", () => {
  type Keepalive = { idleTimeout: number; keepaliveMs: number };
  const withInvariant = defineConfig<{ server: Keepalive }>({
    server: defineGroup<Keepalive>({
      id: "server",
      title: "HTTP server",
      violations: ({ idleTimeout, keepaliveMs }) =>
        keepaliveMs * 3 <= idleTimeout * 1000
          ? []
          : [{ field: "keepaliveMs", message: "must be at most a third of IDLE_TIMEOUT" }],
      fields: {
        idleTimeout: env("IDLE_TIMEOUT", configInt().default(255)),
        keepaliveMs: env("KEEPALIVE_INTERVAL_MS", configInt().default(15_000)),
      },
    }),
  });

  test("reports every problem against its env key instead of throwing", () => {
    expect(checkConfig(config, { env: { ORIGIN: "not-a-url", PORT: "99999" } })).toEqual([
      { fields: [{ envKey: "PORT", pointer: "server.port", groupTitle: "HTTP server" }], message: expect.any(String) },
      { fields: [{ envKey: "ORIGIN", pointer: "origin", groupTitle: undefined }], message: expect.any(String) },
    ]);
  });

  test("a group invariant lands on the field it names, which no per-key check could find", () => {
    expect(checkConfig(withInvariant, { env: { IDLE_TIMEOUT: "20" } })).toEqual([{
      fields: [{ envKey: "KEEPALIVE_INTERVAL_MS", pointer: "server.keepaliveMs", groupTitle: "HTTP server" }],
      message: "must be at most a third of IDLE_TIMEOUT",
    }]);
  });
});

describe("rules spanning members", () => {
  type Audit = { url: string };
  type Licensed = { audit: Audit | undefined; licenseKey?: string };

  const licensed = defineConfig<Licensed>({
    audit: defineGroup<Audit>({
      id: "audit",
      title: "Audit export",
      optional: { requires: ["url"] },
      fields: { url: env("AUDIT_LOKI_URL", z.url()) },
    }),
    licenseKey: env("LICENSE_KEY", z.string().optional()),
  }, {
    violations: (value, at) => value.audit && !value.licenseKey
      ? [{ fields: [at.audit.url, at.licenseKey], message: "needs a licence" }]
      : [],
  });

  test("one violation names every key it is about, across a group and a top-level field", () => {
    expect(checkConfig(licensed, { env: { AUDIT_LOKI_URL: "http://loki:3100" } })).toEqual([{
      fields: [
        { envKey: "AUDIT_LOKI_URL", pointer: "audit.url", groupTitle: "Audit export" },
        { envKey: "LICENSE_KEY", pointer: "licenseKey", groupTitle: undefined },
      ],
      message: "needs a licence",
    }]);
  });

  test("and says nothing once the rule is satisfied", () => {
    expect(checkConfig(licensed, {
      env: { AUDIT_LOKI_URL: "http://loki:3100", LICENSE_KEY: "lic" },
    })).toEqual([]);
  });

  test("a field that failed to parse is reported instead, since the rule needs a whole value", () => {
    expect(checkConfig(licensed, { env: { AUDIT_LOKI_URL: "not-a-url" } }))
      .toEqual([{
        fields: [{ envKey: "AUDIT_LOKI_URL", pointer: "audit.url", groupTitle: "Audit export" }],
        message: expect.any(String),
      }]);
  });
});
