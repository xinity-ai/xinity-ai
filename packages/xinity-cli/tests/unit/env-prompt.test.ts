import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { analyzeConfig, configBool, configInt, defineConfig, defineGroup, env, secret } from "common-env";
import {
  categorizeFields, componentFields, diffEnv,
  missingRequiredFields, planSecretFileRemoval,
  type EnvBundle, type EnvChange,
} from "../../src/lib/env-prompt.ts";
import { readEnvFile, serializeEnvFile, readSecretFiles } from "../../src/lib/env-file.ts";
import { buildSecretsRemoveCommand } from "../../src/lib/service.ts";
import { createTempDir, type TempDir } from "../helpers/temp-config.ts";
import { FakeHost } from "../helpers/fake-host.ts";
import { COMPONENTS, getAutoDefaults } from "../../src/lib/component-meta.ts";

describe("env-prompt", () => {
  // The editor picks its input widget from these, and every leaf parses from a string, so the
  // type has to come from what the leaf produces rather than what it accepts.
  test("analyzeConfig reads a field's type through the string parsing", () => {
    type Cfg = { server: { port: number; debug: boolean; level: "info" | "warn" } };
    const declared = defineConfig<Cfg>({
      server: defineGroup<Cfg["server"]>({
        id: "server",
        title: "Server",
        fields: {
          port: env("PORT", configInt().default(80)),
          debug: env("DEBUG", configBool().default(false)),
          level: env("LEVEL", z.enum(["info", "warn"]).default("info")),
        },
      }),
    });

    const byKey = Object.fromEntries(analyzeConfig(declared).map((f) => [f.key, f]));
    expect(byKey.DEBUG!.isBoolean).toBe(true);
    expect(byKey.PORT!.isBoolean).toBe(false);
    expect(byKey.LEVEL!.enumValues).toEqual(["info", "warn"]);
  });

  describe("field validation", () => {
    const fields = analyzeConfig(defineConfig<{ origin: string; port: number }>({
      origin: env("ORIGIN", z.url()),
      port: env("PORT", configInt(z.int().max(255))),
    }));
    const check = (key: string, raw: string) => fields.find((f) => f.key === key)!.validate(raw);

    test("refuses what the service would refuse at boot", () => {
      expect(check("ORIGIN", "hello$world")).toBeTruthy();
      expect(check("PORT", "300")).toBeTruthy();
      // Number("0x10") is 16, so a numeric coercion would let it through.
      expect(check("PORT", "0x10")).toBeTruthy();
    });

    test("accepts what it would take", () => {
      expect(check("ORIGIN", "https://x.example")).toBeUndefined();
      expect(check("PORT", "80")).toBeUndefined();
    });
  });

  describe("requiredness inside an optional group", () => {
    const s3 = componentFields("gateway").filter((f) => f.group?.id === "s3");
    const endpoint = s3.find((f) => f.key === "S3_ENDPOINT")!;

    test("a member is not demanded while the group is switched off", () => {
      expect(missingRequiredFields(s3, {})).toEqual([]);
    });

    test("but is demanded once something switched the group on", () => {
      expect(missingRequiredFields(s3, { S3_ACCESS_KEY_ID: "AKIA" })).toContain(endpoint);
    });
  });

  describe("categorizeFields", () => {
    test("separates config and secret fields", () => {
      const fields = analyzeConfig(defineConfig<{ host: string; dbPassword: string }>({
        host: env("HOST", z.string()),
        dbPassword: env("DB_PASSWORD", z.string().meta(secret())),
      }));
      const { configFields, secretFields } = categorizeFields(fields);

      expect(configFields.map((f) => f.key)).toEqual(["HOST"]);
      expect(secretFields.map((f) => f.key)).toEqual(["DB_PASSWORD"]);
    });
  });

  describe("isRequired", () => {
    const fields = analyzeConfig(defineConfig<{ host: string; port: number; mailUrl?: string }>({
      host: env("HOST", z.string()),
      port: env("PORT", configInt().default(3000)),
      mailUrl: env("MAIL_URL", z.url().optional()),
    }));
    const field = (key: string) => fields.find((f) => f.key === key)!;

    test("a field without a value or a default is required", () => {
      expect(field("HOST").isRequiredBySchema).toBe(true);
    });

    test("a field with a default is not required, it falls back to it", () => {
      expect(field("PORT").isRequiredBySchema).toBe(false);
      expect(field("PORT").defaultValue).toBe(3000);
    });

    test("an optional field is not required", () => {
      expect(field("MAIL_URL").isRequiredBySchema).toBe(false);
    });
  });

  test("no auto default restates a declared one, which would pin it onto every host", () => {
    const restated = COMPONENTS.flatMap((component) => {
      const byKey = new Map(componentFields(component).map((f) => [f.key, f]));
      return Object.entries(getAutoDefaults(component))
        .filter(([key, value]) => String(byKey.get(key)?.defaultValue) === value)
        .map(([key]) => `${component}.${key}`);
    });

    expect(restated).toEqual([]);
  });

  describe("diffEnv", () => {
    const bundle = (config: Record<string, string>): EnvBundle => ({ config, secrets: {} });

    test("reports added, changed and removed keys", () => {
      const changes = diffEnv(
        bundle({ HOST: "0.0.0.0", PORT: "3000" }),
        bundle({ HOST: "127.0.0.1", LOG_LEVEL: "debug" }),
      );

      expect(changes).toEqual([
        { key: "HOST", kind: "changed", isSecret: false, before: "0.0.0.0", after: "127.0.0.1" },
        { key: "LOG_LEVEL", kind: "added", isSecret: false, after: "debug" },
        { key: "PORT", kind: "removed", isSecret: false },
      ]);
    });
  });

  describe("planSecretFileRemoval", () => {
    const unset = (key: string, isSecret = true): EnvChange => ({ key, kind: "removed", isSecret });

    const hostWith = (...components: string[]) => new FakeHost({
      files: {
        "/opt/xinity/manifest.json": JSON.stringify({
          components: Object.fromEntries(components.map((c) => [c, { version: "0.0.0" }])),
        }),
      },
    });

    test("deletes the file of a secret only this component declares", async () => {
      const plan = await planSecretFileRemoval("dashboard", [unset("MAIL_URL")], hostWith("dashboard", "gateway"));

      expect(plan).toEqual({ remove: ["MAIL_URL"], keptForOtherComponents: [] });
    });

    test("keeps a secret another installed component still reads", async () => {
      const plan = await planSecretFileRemoval("gateway", [unset("METRICS_AUTH")], hostWith("gateway", "dashboard"));

      expect(plan).toEqual({ remove: [], keptForOtherComponents: ["METRICS_AUTH"] });
    });

    test("deletes a shared secret once no other component is installed", async () => {
      const plan = await planSecretFileRemoval("gateway", [unset("METRICS_AUTH")], hostWith("gateway"));

      expect(plan).toEqual({ remove: ["METRICS_AUTH"], keptForOtherComponents: [] });
    });

    test("ignores unset config keys, which the env file rewrite already drops", async () => {
      const plan = await planSecretFileRemoval("gateway", [unset("HOST", false)], hostWith("gateway"));

      expect(plan).toEqual({ remove: [], keptForOtherComponents: [] });
    });
  });

  describe("buildSecretsRemoveCommand", () => {
    test("removes each key's file under the secrets dir", () => {
      expect(buildSecretsRemoveCommand(["MAIL_URL", "LICENSE_KEY"]))
        .toBe("rm -f /etc/xinity-ai/secrets/MAIL_URL /etc/xinity-ai/secrets/LICENSE_KEY");
    });

    test("returns null when nothing was unset", () => {
      expect(buildSecretsRemoveCommand([])).toBeNull();
    });
  });

  describe("readEnvFile", () => {
    let tmp: TempDir;

    beforeEach(() => {
      tmp = createTempDir("env-prompt-test");
    });

    afterEach(() => {
      tmp.cleanup();
    });

    test("returns empty object for missing file", () => {
      const result = readEnvFile(tmp.resolve("nonexistent.env"));
      expect(result).toEqual({});
    });

    test("handles lines without equals sign", () => {
      tmp.write("test.env", "HOST=localhost\nINVALID_LINE\nPORT=3000\n");

      const result = readEnvFile(tmp.resolve("test.env"));
      expect(result).toEqual({ HOST: "localhost", PORT: "3000" });
    });
  });

  describe("serializeEnvFile", () => {
    test("quotes values with special characters", () => {
      const result = serializeEnvFile({ COMMENT: "has # symbol" });
      expect(result).toBe('COMMENT="has # symbol"\n');
    });
  });

  describe("readSecretFiles", () => {
    let tmp: TempDir;

    beforeEach(() => {
      tmp = createTempDir("secrets-test");
    });

    afterEach(() => {
      tmp.cleanup();
    });

    test("reads existing secret files", () => {
      tmp.write("DB_PASSWORD", "supersecret");
      tmp.write("API_KEY", "key-123");

      const result = readSecretFiles(tmp.path, ["DB_PASSWORD", "API_KEY"]);
      expect(result).toEqual({ DB_PASSWORD: "supersecret", API_KEY: "key-123" });
    });

    test("only reads requested keys", () => {
      tmp.write("DB_PASSWORD", "supersecret");
      tmp.write("OTHER_SECRET", "should-not-read");

      const result = readSecretFiles(tmp.path, ["DB_PASSWORD"]);
      expect(result).toEqual({ DB_PASSWORD: "supersecret" });
    });

    test("skips missing files gracefully", () => {
      tmp.write("DB_PASSWORD", "supersecret");

      const result = readSecretFiles(tmp.path, ["DB_PASSWORD", "MISSING_KEY"]);
      expect(result).toEqual({ DB_PASSWORD: "supersecret" });
    });

    test("trims whitespace from secret values", () => {
      tmp.write("TOKEN", "  secret-with-whitespace  \n");

      const result = readSecretFiles(tmp.path, ["TOKEN"]);
      expect(result).toEqual({ TOKEN: "secret-with-whitespace" });
    });
  });
});
