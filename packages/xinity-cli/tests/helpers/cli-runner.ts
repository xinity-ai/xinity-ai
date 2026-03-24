/**
 * Test helper for running CLI commands as subprocesses.
 *
 * Spawns the CLI entry point with given arguments and captures
 * stdout, stderr, and exit code. Supports environment overrides
 * and timeout control.
 */
import { join } from "path";

const CLI_ENTRY = join(import.meta.dir, "../../src/index.ts");

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCliOptions {
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
  stdin?: string;
}

/**
 * Run the CLI with the given arguments and return structured output.
 *
 * Uses Bun.spawn to execute `bun run src/index.ts ...args`.
 * The process inherits no stdin by default (non-interactive).
 */
export async function runCli(opts: RunCliOptions = {}): Promise<CliResult> {
  const { args = [], env = {}, timeout = 10_000 } = opts;

  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin ? new Response(opts.stdin).body! : "ignore",
    env: { ...process.env, ...env },
    cwd: join(import.meta.dir, "../.."),
  });

  const timer = setTimeout(() => proc.kill(), timeout);

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timer);

  return { stdout, stderr, exitCode };
}
