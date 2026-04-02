import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { secret } from "common-env";
import { analyzeEnvSchema, categorizeFields } from "../../src/lib/env-prompt.ts";
import { readEnvFile, serializeEnvFile, readSecretFiles } from "../../src/lib/env-file.ts";
import { createTempDir, type TempDir } from "../helpers/temp-config.ts";

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
      expect(fields[0]!.isEnum).toBe(true);
      expect(fields[0]!.enumValues).toEqual(["debug", "info", "warn", "error"]);
    });

    test("detects secret fields via z.globalRegistry", () => {
      const schema = z.object({
        DB_PASSWORD: z.string().meta(secret()),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields[0]!.isSecret).toBe(true);
    });

    test("marks non-secret fields as not secret", () => {
      const schema = z.object({
        DB_HOST: z.string(),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields[0]!.isSecret).toBe(false);
    });

    test("includes description from .describe()", () => {
      const schema = z.object({
        HOST: z.string().describe("The server hostname"),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields[0]!.description).toBe("The server hostname");
    });

    test("handles multiple fields", () => {
      const schema = z.object({
        HOST: z.string(),
        PORT: z.coerce.number().default(3000),
        SECRET: z.string().meta(secret()),
      });

      const fields = analyzeEnvSchema(schema);
      expect(fields).toHaveLength(3);

      const keys = fields.map((f) => f.key);
      expect(keys).toContain("HOST");
      expect(keys).toContain("PORT");
      expect(keys).toContain("SECRET");
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

    test("handles all-config fields", () => {
      const schema = z.object({
        HOST: z.string(),
        PORT: z.coerce.number(),
      });

      const fields = analyzeEnvSchema(schema);
      const { configFields, secretFields } = categorizeFields(fields);

      expect(configFields).toHaveLength(2);
      expect(secretFields).toHaveLength(0);
    });

    test("handles all-secret fields", () => {
      const schema = z.object({
        TOKEN: z.string().meta(secret()),
      });

      const fields = analyzeEnvSchema(schema);
      const { configFields, secretFields } = categorizeFields(fields);

      expect(configFields).toHaveLength(0);
      expect(secretFields).toHaveLength(1);
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

    test("parses simple KEY=VALUE pairs", () => {
      tmp.write("test.env", "HOST=localhost\nPORT=3000\n");

      const result = readEnvFile(tmp.resolve("test.env"));
      expect(result).toEqual({ HOST: "localhost", PORT: "3000" });
    });

    test("skips empty lines", () => {
      tmp.write("test.env", "HOST=localhost\n\nPORT=3000\n");

      const result = readEnvFile(tmp.resolve("test.env"));
      expect(result).toEqual({ HOST: "localhost", PORT: "3000" });
    });

    test("skips comment lines", () => {
      tmp.write("test.env", "# This is a comment\nHOST=localhost\n# Another comment\n");

      const result = readEnvFile(tmp.resolve("test.env"));
      expect(result).toEqual({ HOST: "localhost" });
    });

    test("strips double quotes from values", () => {
      tmp.write("test.env", 'NAME="hello world"\n');

      const result = readEnvFile(tmp.resolve("test.env"));
      expect(result).toEqual({ NAME: "hello world" });
    });

    test("strips single quotes from values", () => {
      tmp.write("test.env", "NAME='hello world'\n");

      const result = readEnvFile(tmp.resolve("test.env"));
      expect(result).toEqual({ NAME: "hello world" });
    });

    test("handles values with equals signs", () => {
      tmp.write("test.env", "URL=postgres://user:pass@host/db?sslmode=require\n");

      const result = readEnvFile(tmp.resolve("test.env"));
      expect(result).toEqual({ URL: "postgres://user:pass@host/db?sslmode=require" });
    });

    test("handles lines without equals sign", () => {
      tmp.write("test.env", "HOST=localhost\nINVALID_LINE\nPORT=3000\n");

      const result = readEnvFile(tmp.resolve("test.env"));
      expect(result).toEqual({ HOST: "localhost", PORT: "3000" });
    });

    test("trims whitespace around lines", () => {
      tmp.write("test.env", "  HOST=localhost  \n  PORT=3000  \n");

      const result = readEnvFile(tmp.resolve("test.env"));
      expect(result).toEqual({ HOST: "localhost", PORT: "3000" });
    });

    test("handles empty values", () => {
      tmp.write("test.env", "EMPTY=\nHOST=localhost\n");

      const result = readEnvFile(tmp.resolve("test.env"));
      expect(result).toEqual({ EMPTY: "", HOST: "localhost" });
    });
  });

  describe("serializeEnvFile", () => {
    test("serializes simple key-value pairs", () => {
      const result = serializeEnvFile({ HOST: "localhost", PORT: "3000" });
      expect(result).toBe("HOST=localhost\nPORT=3000\n");
    });

    test("quotes values with spaces", () => {
      const result = serializeEnvFile({ NAME: "hello world" });
      expect(result).toBe('NAME="hello world"\n');
    });

    test("quotes values with special characters", () => {
      const result = serializeEnvFile({ COMMENT: "has # symbol" });
      expect(result).toBe('COMMENT="has # symbol"\n');
    });

    test("does not quote simple values", () => {
      const result = serializeEnvFile({ HOST: "localhost" });
      expect(result).toBe("HOST=localhost\n");
    });

    test("handles empty values", () => {
      const result = serializeEnvFile({ EMPTY: "" });
      expect(result).toBe("EMPTY=\n");
    });

    test("ends with newline", () => {
      const result = serializeEnvFile({ A: "1" });
      expect(result.endsWith("\n")).toBe(true);
    });

    test("roundtrips with readEnvFile for simple values", () => {
      const original = { HOST: "localhost", PORT: "3000", URL: "http://example.com" };
      const serialized = serializeEnvFile(original);

      const tmp = createTempDir("roundtrip-test");
      tmp.write("test.env", serialized);
      const parsed = readEnvFile(tmp.resolve("test.env"));
      tmp.cleanup();

      expect(parsed).toEqual(original);
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

    test("returns empty object when no files exist", () => {
      const result = readSecretFiles(tmp.path, ["DB_PASSWORD", "API_KEY"]);
      expect(result).toEqual({});
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
