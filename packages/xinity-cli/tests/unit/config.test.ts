import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createTempDir, redirectXdgConfigHome, type TempDir } from "../helpers/temp-config.ts";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig, updateConfig, configPath } from "../../src/lib/config.ts";

describe("config", () => {
  let tmp: TempDir;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmp = createTempDir("config-test");
    restoreEnv = redirectXdgConfigHome(tmp);
  });

  afterEach(() => {
    restoreEnv();
    tmp.cleanup();
  });

  test("configPath honors XDG_CONFIG_HOME", () => {
    expect(configPath()).toBe(join(tmp.path, "xinity", "config.json"));
  });

  describe("loadConfig", () => {
    test("returns empty object when file does not exist", () => {
      expect(loadConfig()).toEqual({});
    });

    test("loads valid JSON config", () => {
      tmp.write("xinity/config.json", JSON.stringify({ apiKey: "test-key" }));
      expect(loadConfig()).toEqual({ apiKey: "test-key" });
    });

    test("returns empty object for invalid JSON", () => {
      tmp.write("xinity/config.json", "not valid json{{{");
      expect(loadConfig()).toEqual({});
    });

    test("returns empty object for empty file", () => {
      tmp.write("xinity/config.json", "");
      expect(loadConfig()).toEqual({});
    });
  });

  describe("saveConfig", () => {
    test("creates directory and writes config", () => {
      saveConfig({ apiKey: "my-key", dashboardUrl: "http://localhost:5173" });

      expect(tmp.exists("xinity/config.json")).toBe(true);
      expect(loadConfig()).toEqual({ apiKey: "my-key", dashboardUrl: "http://localhost:5173" });
    });

    test("writes pretty-printed JSON with trailing newline", () => {
      saveConfig({ apiKey: "key" });

      const content = readFileSync(configPath(), "utf-8");
      expect(content).toContain("  ");
      expect(content.endsWith("\n")).toBe(true);
    });

    test("overwrites existing config", () => {
      saveConfig({ apiKey: "old-key" });
      saveConfig({ apiKey: "new-key" });

      expect(loadConfig().apiKey).toBe("new-key");
    });

    test("config file is readable only by the user", () => {
      saveConfig({ apiKey: "key" });
      expect(statSync(configPath()).mode & 0o777).toBe(0o600);
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
