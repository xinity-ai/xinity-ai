import { describe, expect, test } from "bun:test";
import { runCli } from "../helpers/cli-runner.ts";

/**
 * CLI argument parsing and help output tests.
 *
 * These tests run the actual CLI as a subprocess, validating that
 * yargs is correctly configured: commands are registered, help text
 * is generated, version is reported, and unknown commands fail.
 */
describe("CLI help and version", () => {
  test("--help shows usage information", async () => {
    const result = await runCli({ args: ["--help"] });

    expect(result.stdout).toContain("xinity");
    expect(result.stdout).toContain("--help");
    expect(result.stdout).toContain("--version");
    expect(result.exitCode).toBe(0);
  });

  test("--version outputs a version string", async () => {
    const result = await runCli({ args: ["--version"] });

    // Version output should match semver-like format with 'v' prefix
    expect(result.stdout.trim()).toMatch(/^v?\d+\.\d+\.\d+/);
    expect(result.exitCode).toBe(0);
  });

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
});

describe("CLI command registration", () => {
  test("help lists 'up' command", async () => {
    const result = await runCli({ args: ["--help"] });
    expect(result.stdout).toContain("up");
  });

  test("help lists 'rm' command", async () => {
    const result = await runCli({ args: ["--help"] });
    expect(result.stdout).toContain("rm");
  });

  test("help lists 'update' command", async () => {
    const result = await runCli({ args: ["--help"] });
    expect(result.stdout).toContain("update");
  });

  test("help lists 'act' command", async () => {
    const result = await runCli({ args: ["--help"] });
    expect(result.stdout).toContain("act");
  });

  test("help lists 'configure' command", async () => {
    const result = await runCli({ args: ["--help"] });
    expect(result.stdout).toContain("configure");
  });

  test("help lists 'doctor' command", async () => {
    const result = await runCli({ args: ["--help"] });
    expect(result.stdout).toContain("doctor");
  });
});

describe("CLI subcommand help", () => {
  test("up --help shows component argument", async () => {
    const result = await runCli({ args: ["up", "--help"] });

    expect(result.stdout).toContain("component");
    expect(result.stdout).toContain("gateway");
    expect(result.stdout).toContain("dashboard");
    expect(result.stdout).toContain("daemon");
    expect(result.exitCode).toBe(0);
  });

  test("up --help shows --dry-run option", async () => {
    const result = await runCli({ args: ["up", "--help"] });

    expect(result.stdout).toContain("dry-run");
    expect(result.exitCode).toBe(0);
  });

  test("up --help shows --target-version option", async () => {
    const result = await runCli({ args: ["up", "--help"] });

    expect(result.stdout).toContain("target-version");
    expect(result.exitCode).toBe(0);
  });

  test("rm --help shows component choices", async () => {
    const result = await runCli({ args: ["rm", "--help"] });

    expect(result.stdout).toContain("component");
    expect(result.stdout).toContain("gateway");
    expect(result.stdout).toContain("dashboard");
    expect(result.stdout).toContain("daemon");
    expect(result.stdout).toContain("all");
    expect(result.exitCode).toBe(0);
  });

  test("rm --help shows --purge option", async () => {
    const result = await runCli({ args: ["rm", "--help"] });

    expect(result.stdout).toContain("purge");
    expect(result.exitCode).toBe(0);
  });

  test("update --help shows --check option", async () => {
    const result = await runCli({ args: ["update", "--help"] });

    expect(result.stdout).toContain("check");
    expect(result.exitCode).toBe(0);
  });

  test("act --help shows route argument", async () => {
    const result = await runCli({ args: ["act", "--help"] });

    expect(result.stdout).toContain("route");
    expect(result.exitCode).toBe(0);
  });

  test("act --help shows --list-routes option", async () => {
    const result = await runCli({ args: ["act", "--help"] });

    expect(result.stdout).toContain("list-routes");
    expect(result.exitCode).toBe(0);
  });

  test("act --help shows --api-key option", async () => {
    const result = await runCli({ args: ["act", "--help"] });

    expect(result.stdout).toContain("api-key");
    expect(result.exitCode).toBe(0);
  });

  test("configure --help shows key and value positionals", async () => {
    const result = await runCli({ args: ["configure", "--help"] });

    expect(result.stdout).toContain("key");
    expect(result.stdout).toContain("value");
    expect(result.exitCode).toBe(0);
  });

  test("configure --help shows --reset option", async () => {
    const result = await runCli({ args: ["configure", "--help"] });

    expect(result.stdout).toContain("reset");
    expect(result.exitCode).toBe(0);
  });

  test("configure --help lists valid config keys", async () => {
    const result = await runCli({ args: ["configure", "--help"] });

    expect(result.stdout).toContain("apiKey");
    expect(result.stdout).toContain("dashboardUrl");
    expect(result.stdout).toContain("githubProjectUrl");
    expect(result.stdout).toContain("githubToken");
    expect(result.exitCode).toBe(0);
  });
});

describe("CLI completion", () => {
  test("help lists 'completion' command", async () => {
    const result = await runCli({ args: ["--help"] });
    expect(result.stdout).toContain("completion");
    expect(result.exitCode).toBe(0);
  });

  test("completion bash outputs bash script", async () => {
    const result = await runCli({ args: ["completion", "bash"] });

    expect(result.stdout).toContain("###-begin-xinity-completions-###");
    expect(result.stdout).toContain("_xinity_yargs_completions");
    expect(result.stdout).toContain("COMPREPLY");
    expect(result.exitCode).toBe(0);
  });

  test("completion zsh outputs zsh script", async () => {
    const result = await runCli({ args: ["completion", "zsh"] });

    expect(result.stdout).toContain("#compdef xinity");
    expect(result.stdout).toContain("compdef _xinity xinity");
    expect(result.stdout).toContain("compadd");
    expect(result.exitCode).toBe(0);
  });

  test("completion fish outputs fish script", async () => {
    const result = await runCli({ args: ["completion", "fish"] });

    expect(result.stdout).toContain("complete -c xinity");
    expect(result.stdout).toContain("__xinity_completions");
    expect(result.stdout).toContain("commandline");
    expect(result.exitCode).toBe(0);
  });

  test("completion auto-detects shell from $SHELL", async () => {
    const result = await runCli({
      args: ["completion"],
      env: { SHELL: "/bin/zsh" },
    });

    expect(result.stdout).toContain("#compdef xinity");
    expect(result.exitCode).toBe(0);
  });

  test("completion with invalid shell shows error", async () => {
    const result = await runCli({ args: ["completion", "powershell"] });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid values");
  });
});

describe("CLI argument validation", () => {
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

  test("rm without component shows error", async () => {
    const result = await runCli({ args: ["rm"] });

    expect(result.exitCode).not.toBe(0);
  });

  test("rm with invalid component shows error", async () => {
    const result = await runCli({ args: ["rm", "invalid"] });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid values");
  });
});
