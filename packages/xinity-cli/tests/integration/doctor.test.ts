import { describe, expect, test } from "bun:test";
import { runCli } from "../helpers/cli-runner.ts";

/**
 * Doctor command integration tests.
 *
 * The `--format json` flag makes these tests deterministic: clack UI
 * chrome goes to stderr (see src/lib/clack.ts) so stdout is pure JSON.
 * `--no-interactive` disables sudo prompts so the runner never blocks.
 *
 * Tests cover both the JSON API contract and the text rendering path.
 * They are designed to pass in a dev environment where no Xinity
 * components are installed, i.e. /opt/xinity/manifest.json is absent.
 */
describe("doctor command", () => {
  // ─── Help ────────────────────────────────────────────────────────────────

  describe("doctor --help", () => {
    test("shows --verbose / -v option", async () => {
      const result = await runCli({ args: ["doctor", "--help"] });
      expect(result.stdout).toContain("verbose");
      expect(result.exitCode).toBe(0);
    });

    test("shows --format option", async () => {
      const result = await runCli({ args: ["doctor", "--help"] });
      expect(result.stdout).toContain("format");
      expect(result.exitCode).toBe(0);
    });

    test("lists 'text' and 'json' as format choices", async () => {
      const result = await runCli({ args: ["doctor", "--help"] });
      expect(result.stdout).toContain("text");
      expect(result.stdout).toContain("json");
      expect(result.exitCode).toBe(0);
    });

    test("shows --interactive option", async () => {
      const result = await runCli({ args: ["doctor", "--help"] });
      expect(result.stdout).toContain("interactive");
      expect(result.exitCode).toBe(0);
    });
  });

  // ─── JSON output contract ─────────────────────────────────────────────────

  describe("doctor --format json", () => {
    test("stdout is valid JSON", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });

    test("has top-level timestamp, components, and summary fields", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const report = JSON.parse(result.stdout);
      expect(report).toHaveProperty("timestamp");
      expect(report).toHaveProperty("components");
      expect(report).toHaveProperty("summary");
      expect(Array.isArray(report.components)).toBe(true);
    });

    test("timestamp is a valid ISO 8601 date string", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { timestamp } = JSON.parse(result.stdout);
      expect(typeof timestamp).toBe("string");
      expect(new Date(timestamp).toISOString()).toBe(timestamp);
    });

    test("summary has numeric pass / warn / fail / skip fields", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { summary } = JSON.parse(result.stdout);
      expect(typeof summary.pass).toBe("number");
      expect(typeof summary.warn).toBe("number");
      expect(typeof summary.fail).toBe("number");
      expect(typeof summary.skip).toBe("number");
    });

    test("all summary counts are non-negative", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { summary } = JSON.parse(result.stdout);
      expect(summary.pass).toBeGreaterThanOrEqual(0);
      expect(summary.warn).toBeGreaterThanOrEqual(0);
      expect(summary.fail).toBeGreaterThanOrEqual(0);
      expect(summary.skip).toBeGreaterThanOrEqual(0);
    });

    // ─── System component ─────────────────────────────────────────────────

    test("components array includes a 'system' entry", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { components } = JSON.parse(result.stdout);
      const system = components.find((c: any) => c.component === "system");
      expect(system).toBeDefined();
    });

    test("system component reports installed: true", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { components } = JSON.parse(result.stdout);
      const system = components.find((c: any) => c.component === "system");
      expect(system.installed).toBe(true);
    });

    test("system component has a Platform check", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { components } = JSON.parse(result.stdout);
      const system = components.find((c: any) => c.component === "system");
      const platform = system.checks.find((c: any) => c.label === "Platform");
      expect(platform).toBeDefined();
      expect(["pass", "warn", "fail", "skip"]).toContain(platform.status);
    });

    test("system component has a Manifest check", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { components } = JSON.parse(result.stdout);
      const system = components.find((c: any) => c.component === "system");
      const manifest = system.checks.find((c: any) => c.label === "Manifest");
      expect(manifest).toBeDefined();
    });

    test("system component has a systemd check", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { components } = JSON.parse(result.stdout);
      const system = components.find((c: any) => c.component === "system");
      const systemd = system.checks.find((c: any) => c.label === "systemd");
      expect(systemd).toBeDefined();
    });

    // ─── Installable components ───────────────────────────────────────────

    test("report includes all four installable components", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { components } = JSON.parse(result.stdout);
      const names = components.map((c: any) => c.component);
      expect(names).toContain("gateway");
      expect(names).toContain("dashboard");
      expect(names).toContain("daemon");
      expect(names).toContain("infoserver");
    });

    test("uninstalled components are reported with installed: false", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { components } = JSON.parse(result.stdout);
      for (const name of ["gateway", "dashboard", "daemon", "infoserver"]) {
        const comp = components.find((c: any) => c.component === name);
        if (comp && !comp.installed) {
          // Every check on a not-installed component should be "skip"
          expect(
            comp.checks.every((c: any) => c.status === "skip"),
          ).toBe(true);
        }
      }
    });

    // ─── Check shape validation ───────────────────────────────────────────

    test("every check has label (string), status (valid), and message (string)", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { components } = JSON.parse(result.stdout);
      const validStatuses = new Set(["pass", "warn", "fail", "skip"]);
      for (const comp of components) {
        for (const check of comp.checks) {
          expect(typeof check.label).toBe("string");
          expect(typeof check.message).toBe("string");
          expect(validStatuses.has(check.status)).toBe(true);
        }
      }
    });

    test("optional 'detail' field is always a string when present", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { components } = JSON.parse(result.stdout);
      for (const comp of components) {
        for (const check of comp.checks) {
          if ("detail" in check) {
            expect(typeof check.detail).toBe("string");
          }
        }
      }
    });

    // ─── Exit code ────────────────────────────────────────────────────────

    test("exits 0 when summary.fail is 0", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { summary } = JSON.parse(result.stdout);
      if (summary.fail === 0) {
        expect(result.exitCode).toBe(0);
      }
    });

    test("exits 1 when summary.fail is greater than 0", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "json", "--no-interactive"],
      });
      const { summary } = JSON.parse(result.stdout);
      if (summary.fail > 0) {
        expect(result.exitCode).toBe(1);
      }
    });
  });

  // ─── Text format ──────────────────────────────────────────────────────────

  describe("doctor text format (default)", () => {
    test("outputs a SYSTEM section header in stdout", async () => {
      const result = await runCli({ args: ["doctor", "--no-interactive"] });
      expect(result.stdout).toContain("SYSTEM");
    });

    test("exit code matches failure count reported in JSON", async () => {
      const [textResult, jsonResult] = await Promise.all([
        runCli({ args: ["doctor", "--no-interactive"] }),
        runCli({ args: ["doctor", "--format", "json", "--no-interactive"] }),
      ]);
      const { summary } = JSON.parse(jsonResult.stdout);
      expect(textResult.exitCode).toBe(summary.fail > 0 ? 1 : 0);
    });

    test("--verbose flag is accepted without error", async () => {
      const result = await runCli({
        args: ["doctor", "--verbose", "--no-interactive"],
      });
      expect(result.stderr).not.toContain("Unknown argument");
      expect(result.stderr).not.toContain("Invalid values");
    });

    test("--format invalid is rejected by yargs", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "xml"],
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid values");
    });
  });

  // ─── YAML format ─────────────────────────────────────────────────────────

  describe("doctor --format yaml", () => {
    test("--format yaml outputs YAML with top-level keys", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "yaml", "--no-interactive"],
      });
      expect(result.stderr).not.toContain("Invalid values");
      expect(result.stdout).toContain("timestamp:");
      expect(result.stdout).toContain("components:");
      expect(result.stdout).toContain("summary:");
    });

    test("yaml exit code matches json exit code", async () => {
      const [yaml, json] = await Promise.all([
        runCli({ args: ["doctor", "--format", "yaml", "--no-interactive"] }),
        runCli({ args: ["doctor", "--format", "json", "--no-interactive"] }),
      ]);
      expect(yaml.exitCode).toBe(json.exitCode);
    });

    test("--format toml is rejected by yargs", async () => {
      const result = await runCli({
        args: ["doctor", "--format", "toml"],
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid values");
    });
  });
});
