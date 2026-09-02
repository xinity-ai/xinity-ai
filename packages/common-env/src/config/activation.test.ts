import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineGroup, env } from "./group";
import { defineConfig } from "./build";
import { checkGroupActivation, isGroupActive } from "./activation";

type ObjectStorage = { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string };
type Server = { host: string };

const config = defineConfig<{ s3: ObjectStorage | undefined; server: Server }>({
  s3: defineGroup<ObjectStorage>({
    id: "s3",
    title: "Object storage",
    optional: { requires: ["endpoint", "accessKeyId", "secretAccessKey"] },
    fields: {
      endpoint: env("S3_ENDPOINT", z.url()),
      accessKeyId: env("S3_ACCESS_KEY_ID", z.string()),
      secretAccessKey: env("S3_SECRET_ACCESS_KEY", z.string()),
      bucket: env("S3_BUCKET", z.string().default("xinity-media")),
    },
  }),
  server: defineGroup<Server>({
    id: "server",
    title: "HTTP server",
    fields: { host: env("HOST", z.string().default("localhost")) },
  }),
});

const check = (raw: Record<string, unknown>) => checkGroupActivation(config, raw);

const ALL_SET = {
  S3_ENDPOINT: "http://seaweedfs:8333",
  S3_ACCESS_KEY_ID: "AKIA",
  S3_SECRET_ACCESS_KEY: "shhh",
};

describe("classification", () => {
  test("every required key present is active, with no warning", () => {
    const report = check(ALL_SET);
    expect(report.byKey.get("s3")!.state).toBe("active");
    expect(report.warnings).toEqual([]);
  });

  test("no required key present is inactive, with no warning", () => {
    const report = check({ S3_BUCKET: "set-but-not-required" });
    expect(report.byKey.get("s3")!.state).toBe("inactive");
    expect(report.warnings).toEqual([]);
  });

  test("some present is partial, and names what was found and what was missing", () => {
    const report = check({ S3_ENDPOINT: "http://seaweedfs:8333" });
    const s3 = report.byKey.get("s3")!;

    expect(s3.state).toBe("partial");
    expect(s3.present).toEqual(["S3_ENDPOINT"]);
    expect(s3.missing).toEqual(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]!.message).toContain("Object storage is not active");
    expect(report.warnings[0]!.message).toContain("present: S3_ENDPOINT");
    expect(report.warnings[0]!.message).toContain("missing: S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
  });
});

test("a value that parseEnv would treat as unset does not activate", () => {
  for (const empty of ["", null, undefined]) {
    expect(check({ ...ALL_SET, S3_ENDPOINT: empty }).byKey.get("s3")!.state).toBe("partial");
  }
});

test("groups that cannot be absent are not classified and count as active", () => {
  const report = check({});
  expect(report.byKey.has("server")).toBe(false);
  expect(isGroupActive(report, "server")).toBe(true);
  expect(isGroupActive(report, "s3")).toBe(false);
  expect(isGroupActive(check(ALL_SET), "s3")).toBe(true);
});
