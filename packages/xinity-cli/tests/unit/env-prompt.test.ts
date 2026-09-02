import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { secret } from "common-env";
import {
  analyzeEnvSchema, categorizeFields, diffEnv, planSecretFileRemoval,
  type EnvBundle, type EnvChange,
} from "../../src/lib/env-prompt.ts";
import { readEnvFile, serializeEnvFile, readSecretFiles } from "../../src/lib/env-file.ts";
import { buildSecretsRemoveCommand } from "../../src/lib/service.ts";
import { createTempDir, type TempDir } from "../helpers/temp-config.ts";
import { FakeHost } from "../helpers/fake-host.ts";

describe("env-prompt", () => {
  describe("analyzeEnvSchema", () => {
    test("detects required string fields", () => {
      const schema = z.object({
        HOST: z.string(),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields).toHaveLength(1);
      expect(fields[0]!.key).toBe("HOST");
      expect(fields[0]!.isOptional).toBe(false);
      expect(fields[0]!.hasDefault).toBe(false);
    });

    test("detects optional fields", () => {
      const schema = z.object({
        DEBUG: z.string().optional(),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields[0]!.isOptional).toBe(true);
    });

    test("detects fields with defaults", () => {
      const schema = z.object({
        PORT: z.coerce.number().default(3000),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields[0]!.hasDefault).toBe(true);
      expect(fields[0]!.defaultValue).toBe(3000);
      // Listed as required in the JSON schema, but the default satisfies it.
      expect(fields[0]!.isOptional).toBe(false);
      expect(fields[0]!.isRequired).toBe(false);
    });

    test("detects number fields", () => {
      const schema = z.object({
        PORT: z.coerce.number(),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields[0]!.isNumber).toBe(true);
      expect(fields[0]!.isBoolean).toBe(false);
    });

    test("detects boolean fields", () => {
      const schema = z.object({
        VERBOSE: z.boolean().default(false),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields[0]!.isBoolean).toBe(true);
      expect(fields[0]!.isNumber).toBe(false);
    });

    test("detects enum fields", () => {
      const schema = z.object({
        LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields[0]!.enumValues).toEqual(["debug", "info", "warn", "error"]);
    });

    test("detects secret fields via z.globalRegistry", () => {
      const schema = z.object({
        DB_PASSWORD: z.string().meta(secret()),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields[0]!.isSecret).toBe(true);
    });

    test("includes description from .describe()", () => {
      const schema = z.object({
        HOST: z.string().describe("The server hostname"),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields[0]!.description).toBe("The server hostname");
    });

  });

  describe("categorizeFields", () => {
    test("separates config and secret fields", () => {
      const schema = z.object({
        HOST: z.string(),
        PORT: z.coerce.number(),
        DB_PASSWORD: z.string().meta(secret()),
        API_KEY: z.string().meta(secret()),
      });

      const fields = analyzeEnvSchema(schema);
      const { configFields, secretFields } = categorizeFields(fields);

      expect(configFields).toHaveLength(2);
      expect(secretFields).toHaveLength(2);
      expect(configFields.map((f) => f.key)).toEqual(["HOST", "PORT"]);
      expect(secretFields.map((f) => f.key)).toEqual(["DB_PASSWORD", "API_KEY"]);
    });

  });

  describe("isRequired", () => {
    const fields = analyzeEnvSchema(z.object({
      HOST: z.string(),
      PORT: z.coerce.number().default(3000),
      MAIL_URL: z.url().optional(),
    }));
    const field = (key: string) => fields.find((f) => f.key === key)!;

    test("a field without a value or a default is required", () => {
      expect(field("HOST").isRequired).toBe(true);
    });

    test("a field with a default is not required, it falls back to it", () => {
      expect(field("PORT").isRequired).toBe(false);
    });

    test("an optional field is not required", () => {
      expect(field("MAIL_URL").isRequired).toBe(false);
    });
  });

  describe("diffEnv", () => {
    const bundle = (config: Record<string, string>): EnvBundle => ({ config, secrets: {} });

    test("reports added, changed and removed keys", () => {
      const changes = diffEnv(
        "gateway",
        bundle({ HOST: "0.0.0.0", PORT: "3000" }),
        bundle({ HOST: "127.0.0.1", LOG_LEVEL: "debug" }),
      );

      expect(changes).toEqual([
        { key: "HOST", kind: "changed", isSecret: false, before: "0.0.0.0", after: "127.0.0.1" },
        { key: "LOG_LEVEL", kind: "added", isSecret: false, after: "debug" },
        { key: "PORT", kind: "removed", isSecret: false },
      ]);
    });

    test("a key the writer derives is never reported as removed", () => {
      const changes = diffEnv(
        "dashboard",
        bundle({ ORIGIN: "https://xinity.test", HTTP_OVERRIDE_ORIGIN: "https://xinity.test" }),
        bundle({ ORIGIN: "https://xinity.test" }),
      );

      expect(changes).toEqual([]);
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
