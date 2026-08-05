import { describe, expect, test } from "bun:test";
import { runCli } from "../helpers/cli-runner.ts";

/**
 * CLI argument parsing tests.
 *
 * These tests run the actual CLI as a subprocess, validating that
 * yargs is correctly configured: a bare invocation fails, unknown
 * commands and invalid choices are rejected.
 */
describe("CLI argument parsing", () => {
  test("no arguments shows help with error", async () => {
    const result = await runCli({ args: [] });

    // yargs demandCommand should show help and exit with error
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Run xinity --help for available commands");
  });

  test("unknown command exits with error", async () => {
    const result = await runCli({ args: ["nonexistent"] });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown argument");
  });

  test("up without component shows error", async () => {
    const result = await runCli({ args: ["up"] });

    expect(result.exitCode).not.toBe(0);
  });

  test("up with invalid component shows error", async () => {
    const result = await runCli({ args: ["up", "invalid"] });

    expect(result.exitCode).not.toBe(0);
    // yargs should reject invalid choices
    expect(result.stderr).toContain("Invalid values");
  });
});

describe("CLI completion", () => {
  test("completion auto-detects shell from $SHELL", async () => {
    const result = await runCli({
      args: ["completion"],
      env: { SHELL: "/bin/zsh" },
    });

    expect(result.stdout).toContain("#compdef xinity");
    expect(result.exitCode).toBe(0);
  });
});
