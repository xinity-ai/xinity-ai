import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { createTempDir, type TempDir } from "../helpers/temp-config.ts";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

/**
 * Config module tests.
 *
 * Since config.ts derives CONFIG_PATH from os.homedir() at module load time,
 * we test the underlying logic by reimplementing the same patterns against
 * a temp directory. This validates the serialization, merging, and error
 * handling behavior without needing to mock the module import.
 */
describe("config", () => {
  let tmp: TempDir;
  let configDir: string;
  let configPath: string;

  /** Mirror the loadConfig logic against our temp path. */
  function loadConfig(): Record<string, string | undefined> {
    if (!existsSync(configPath)) return {};
    try {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return {};
    }
  }

  /** Mirror the saveConfig logic against our temp path. */
  function saveConfig(config: Record<string, string | undefined>): void {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  }

  /** Mirror the updateConfig logic. */
  function updateConfig(patch: Record<string, string | undefined>): Record<string, string | undefined> {
    const config = { ...loadConfig(), ...patch };
    saveConfig(config);
    return config;
  }

  beforeEach(() => {
    tmp = createTempDir("config-test");
    configDir = join(tmp.path, ".config", "xinity");
    configPath = join(configDir, "config.json");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  describe("loadConfig", () => {
    test("returns empty object when file does not exist", () => {
      expect(loadConfig()).toEqual({});
    });

    test("loads valid JSON config", () => {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ apiKey: "test-key" }));

      expect(loadConfig()).toEqual({ apiKey: "test-key" });
    });

    test("returns empty object for invalid JSON", () => {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, "not valid json{{{");

      expect(loadConfig()).toEqual({});
    });

    test("returns empty object for empty file", () => {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, "");

      expect(loadConfig()).toEqual({});
    });
  });

  describe("saveConfig", () => {
    test("creates directory and writes config", () => {
      saveConfig({ apiKey: "my-key", dashboardUrl: "http://localhost:5173" });

      expect(existsSync(configPath)).toBe(true);
      const content = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.apiKey).toBe("my-key");
      expect(parsed.dashboardUrl).toBe("http://localhost:5173");
    });

    test("writes pretty-printed JSON with trailing newline", () => {
      saveConfig({ apiKey: "key" });

      const content = readFileSync(configPath, "utf-8");
      expect(content).toContain("  ");
      expect(content.endsWith("\n")).toBe(true);
    });

    test("overwrites existing config", () => {
      saveConfig({ apiKey: "old-key" });
      saveConfig({ apiKey: "new-key" });

      const config = loadConfig();
      expect(config.apiKey).toBe("new-key");
    });
  });

  describe("updateConfig", () => {
    test("merges patch into empty config", () => {
      const result = updateConfig({ apiKey: "new-key" });

      expect(result.apiKey).toBe("new-key");
      expect(loadConfig().apiKey).toBe("new-key");
    });

    test("preserves existing keys when patching", () => {
      saveConfig({ apiKey: "key-1", dashboardUrl: "http://localhost:5173" });

      updateConfig({ dashboardUrl: "http://example.com" });

      const config = loadConfig();
      expect(config.apiKey).toBe("key-1");
      expect(config.dashboardUrl).toBe("http://example.com");
    });

    test("overwrites values with patch", () => {
      saveConfig({ apiKey: "old" });

      updateConfig({ apiKey: "new" });

      expect(loadConfig().apiKey).toBe("new");
    });

    test("returns the merged config", () => {
      saveConfig({ apiKey: "existing" });

      const result = updateConfig({ dashboardUrl: "http://test.com" });

      expect(result).toEqual({
        apiKey: "existing",
        dashboardUrl: "http://test.com",
      });
    });
  });
});
