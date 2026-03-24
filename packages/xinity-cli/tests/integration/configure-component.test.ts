import { describe, expect, test } from "bun:test";
import { runCli } from "../helpers/cli-runner.ts";

/**
 * Configure command: component mode integration tests.
 *
 * Tests the `xinity configure <component>` interactive path.
 * Since the test runner closes stdin, interactive prompts immediately
 * cancel; tests focus on yargs argument validation rather than prompt
 * flow.
 */
describe("configure command > component mode", () => {
  describe("configure --help includes component choices", () => {
    test("shows 'cli' as a choice", async () => {
      const result = await runCli({ args: ["configure", "--help"] });
      expect(result.stdout).toContain("cli");
      expect(result.exitCode).toBe(0);
    });

    test("shows 'gateway' as a choice", async () => {
      const result = await runCli({ args: ["configure", "--help"] });
      expect(result.stdout).toContain("gateway");
      expect(result.exitCode).toBe(0);
    });

    test("shows 'dashboard' as a choice", async () => {
      const result = await runCli({ args: ["configure", "--help"] });
      expect(result.stdout).toContain("dashboard");
      expect(result.exitCode).toBe(0);
    });

    test("shows 'daemon' as a choice", async () => {
      const result = await runCli({ args: ["configure", "--help"] });
      expect(result.stdout).toContain("daemon");
      expect(result.exitCode).toBe(0);
    });

    test("shows 'infoserver' as a choice", async () => {
      const result = await runCli({ args: ["configure", "--help"] });
      expect(result.stdout).toContain("infoserver");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("configure accepts valid components without validation errors", () => {
    // With stdin closed the interactive prompt immediately receives EOF and
    // cancels. These tests only verify that yargs doesn't reject the argument.

    test("configure cli is accepted by yargs", async () => {
      const result = await runCli({ args: ["configure", "cli"] });
      expect(result.stderr).not.toContain("Invalid values");
      expect(result.stderr).not.toContain("Unknown argument");
    });

    test("configure gateway is accepted by yargs", async () => {
      const result = await runCli({ args: ["configure", "gateway"] });
      expect(result.stderr).not.toContain("Invalid values");
      expect(result.stderr).not.toContain("Unknown argument");
    });

    test("configure dashboard is accepted by yargs", async () => {
      const result = await runCli({ args: ["configure", "dashboard"] });
      expect(result.stderr).not.toContain("Invalid values");
      expect(result.stderr).not.toContain("Unknown argument");
    });

    test("configure daemon is accepted by yargs", async () => {
      const result = await runCli({ args: ["configure", "daemon"] });
      expect(result.stderr).not.toContain("Invalid values");
      expect(result.stderr).not.toContain("Unknown argument");
    });

    test("configure infoserver is accepted by yargs", async () => {
      const result = await runCli({ args: ["configure", "infoserver"] });
      expect(result.stderr).not.toContain("Invalid values");
      expect(result.stderr).not.toContain("Unknown argument");
    });

    test("configure with no args defaults to cli (no yargs error)", async () => {
      const result = await runCli({ args: ["configure"] });
      expect(result.stderr).not.toContain("Invalid values");
      expect(result.stderr).not.toContain("Unknown argument");
    });
  });

  describe("configure rejects invalid component/key names", () => {
    test("configure postgres is rejected with Invalid values", async () => {
      const result = await runCli({ args: ["configure", "postgres"] });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid values");
    });

    test("configure redis is rejected with Invalid values", async () => {
      const result = await runCli({ args: ["configure", "redis"] });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid values");
    });

    test("configure with an unrecognised key and value is rejected", async () => {
      const result = await runCli({ args: ["configure", "notacomponent", "somevalue"] });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid values");
    });
  });

  describe("configure component produces meaningful stderr output", () => {
    // Clack UI chrome goes to stderr; intro line should always appear.

    test("configure gateway writes an intro header to stderr", async () => {
      const result = await runCli({ args: ["configure", "gateway"] });
      expect(result.stderr).toContain("gateway");
    });

    test("configure dashboard writes an intro header to stderr", async () => {
      const result = await runCli({ args: ["configure", "dashboard"] });
      expect(result.stderr).toContain("dashboard");
    });

    test("configure daemon writes an intro header to stderr", async () => {
      const result = await runCli({ args: ["configure", "daemon"] });
      expect(result.stderr).toContain("daemon");
    });

    test("configure infoserver writes an intro header to stderr", async () => {
      const result = await runCli({ args: ["configure", "infoserver"] });
      expect(result.stderr).toContain("infoserver");
    });
  });
});
