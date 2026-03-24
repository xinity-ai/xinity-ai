import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { runCli } from "../helpers/cli-runner.ts";
import { createTempDir, type TempDir } from "../helpers/temp-config.ts";
import { join } from "path";
import { readFileSync, mkdirSync, writeFileSync } from "fs";

/**
 * Configure command integration tests.
 *
 * Tests the `xinity configure <key> <value>` direct-set mode, which
 * doesn't require interactive prompts. Uses a temp HOME directory
 * to isolate config file operations.
 */
describe("configure command", () => {
  let tmp: TempDir;

  beforeEach(() => {
    tmp = createTempDir("cli-configure-test");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  function configPath(): string {
    return join(tmp.path, ".config", "xinity", "config.json");
  }

  function readConfig(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(configPath(), "utf-8"));
    } catch {
      return {};
    }
  }

  test("configure <key> <value> sets a config value", async () => {
    const result = await runCli({
      args: ["configure", "dashboardUrl", "http://test.example.com"],
      env: { HOME: tmp.path },
    });

    // Should succeed (exit 0) with non-interactive set
    expect(result.exitCode).toBe(0);

    const config = readConfig();
    expect(config.dashboardUrl).toBe("http://test.example.com");
  });

  test("configure sets multiple values sequentially", async () => {
    await runCli({
      args: ["configure", "dashboardUrl", "http://first.com"],
      env: { HOME: tmp.path },
    });

    await runCli({
      args: ["configure", "githubProjectUrl", "https://github.com/test/repo"],
      env: { HOME: tmp.path },
    });

    const config = readConfig();
    expect(config.dashboardUrl).toBe("http://first.com");
    expect(config.githubProjectUrl).toBe("https://github.com/test/repo");
  });

  test("configure overwrites existing value", async () => {
    await runCli({
      args: ["configure", "dashboardUrl", "http://old.com"],
      env: { HOME: tmp.path },
    });

    await runCli({
      args: ["configure", "dashboardUrl", "http://new.com"],
      env: { HOME: tmp.path },
    });

    const config = readConfig();
    expect(config.dashboardUrl).toBe("http://new.com");
  });

  test("configure --reset clears a config key", async () => {
    // Set a value first
    await runCli({
      args: ["configure", "apiKey", "test-key-123"],
      env: { HOME: tmp.path },
    });
    expect(readConfig().apiKey).toBe("test-key-123");

    // Reset it
    const result = await runCli({
      args: ["configure", "--reset", "apiKey"],
      env: { HOME: tmp.path },
    });

    expect(result.exitCode).toBe(0);
    expect(readConfig().apiKey).toBeUndefined();
  });

  test("configure --reset preserves other keys", async () => {
    await runCli({
      args: ["configure", "apiKey", "key-1"],
      env: { HOME: tmp.path },
    });
    await runCli({
      args: ["configure", "dashboardUrl", "http://test.com"],
      env: { HOME: tmp.path },
    });

    await runCli({
      args: ["configure", "--reset", "apiKey"],
      env: { HOME: tmp.path },
    });

    const config = readConfig();
    expect(config.apiKey).toBeUndefined();
    expect(config.dashboardUrl).toBe("http://test.com");
  });

  test("configure rejects invalid key", async () => {
    const result = await runCli({
      args: ["configure", "invalidKey", "value"],
      env: { HOME: tmp.path },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid values");
  });
});
