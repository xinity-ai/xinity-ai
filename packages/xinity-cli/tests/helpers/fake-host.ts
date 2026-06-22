/**
 * In-memory Host double for unit-testing the setup assistants' I/O logic
 * (Docker detection, daemon readiness, pre-existing-state probing) without a
 * real Docker, sudo, or SSH. Responses are scripted per command.
 *
 * Only the methods the infra setups actually use are wired meaningfully; the
 * rest return inert defaults so the Host interface is satisfied.
 */
import type { Host, RunResult, ElevationResult } from "../../src/lib/host.ts";

type RunHandler = (args: string[]) => Partial<RunResult> | undefined;
type ShellHandler = (command: string) => Partial<RunResult> | undefined;
type ElevationHandler = (command: string) => Partial<ElevationResult> | undefined;

export interface FakeHostConfig {
  /** Map a `run(args)` call to a result; return undefined to fall through to the default (failure). */
  run?: RunHandler;
  /** Map a `runShell(cmd)` call to a result; default is failure (command not found). */
  runShell?: ShellHandler;
  /** Map a `withElevation(cmd)` call to a result; default is success (so writes "succeed"). */
  withElevation?: ElevationHandler;
  /** Virtual filesystem for readFile/fileExists. */
  files?: Record<string, string>;
  isRemote?: boolean;
}

const FAIL: RunResult = { ok: false, output: "", exitCode: 1 };
const OK: RunResult = { ok: true, output: "", exitCode: 0 };

export class FakeHost implements Host {
  readonly isRemote: boolean;
  /** Every command string seen, in order, for assertions. */
  readonly calls: string[] = [];

  constructor(private readonly config: FakeHostConfig = {}) {
    this.isRemote = config.isRemote ?? false;
  }

  async run(args: string[]): Promise<RunResult> {
    this.calls.push(args.join(" "));
    return { ...FAIL, ...this.config.run?.(args) };
  }

  async runShell(command: string): Promise<RunResult> {
    this.calls.push(command);
    return { ...FAIL, ...this.config.runShell?.(command) };
  }

  async withElevation(command: string): Promise<ElevationResult> {
    this.calls.push(command);
    const base: ElevationResult = { success: true, output: "", skipped: false };
    return { ...base, ...this.config.withElevation?.(command) };
  }

  async readFile(path: string): Promise<string | null> {
    return this.config.files?.[path] ?? null;
  }

  async fileExists(path: string): Promise<boolean> {
    return this.config.files?.[path] !== undefined;
  }

  async uploadFile(localPath: string, destPath: string): Promise<string> {
    return destPath || localPath;
  }
  async downloadFile(): Promise<void> {}
  async verifySha256(): Promise<boolean> { return true; }
  async computeSha256(): Promise<string | null> { return null; }
  async getArch(): Promise<string> { return "x64"; }
  async openTunnel(url: string): Promise<{ localUrl: string; close: () => Promise<void> }> {
    return { localUrl: url, close: async () => {} };
  }
  async dispose(): Promise<void> {}
}

export { OK as RUN_OK, FAIL as RUN_FAIL };
