/**
 * Host abstraction for local and remote (SSH) execution.
 *
 * All operations that touch the filesystem or run commands go through a Host
 * instance, enabling transparent remote execution with --target-host.
 *
 * The raw `localRun` / `localRunInteractive` helpers are exported for use by
 * RemoteHost (which executes SSH commands on the local machine). Consumer code
 * should NEVER import them; always use a Host instance instead.
 */
import { existsSync, readFileSync } from "fs";
import * as p from "./clack.ts";
import pc from "picocolors";

// ─── Low-level shell primitives ─────────────────────────────────────────────
// Used only by LocalHost / RemoteHost implementations.

export interface RunResult {
  ok: boolean;
  output: string;
  exitCode: number;
}

/** Run a command quietly, returning structured result instead of throwing. */
export async function localRun(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    ok: exitCode === 0,
    output: (stdout || stderr).trim(),
    exitCode,
  };
}

/** Run a command with inherited stdio (for interactive prompts like sudo). */
export async function localRunInteractive(args: string[]): Promise<RunResult> {
  // Pause stdin before handing it to the child process so Bun's internal
  // stream state doesn't get corrupted when the child exits.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();

  const proc = Bun.spawn(args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  // Restore stdin for subsequent @clack/prompts usage.
  // Without this, the next interactive prompt may read EOF and
  // immediately cancel because Bun left the stream paused/ended.
  process.stdin.resume();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  return {
    ok: exitCode === 0,
    output: "",
    exitCode,
  };
}

// ─── Elevation (sudo) ──────────────────────────────────────────────────────

export interface ElevationResult {
  success: boolean;
  output: string;
  skipped: boolean;
}

function isRoot(): boolean {
  return process.getuid?.() === 0;
}

/**
 * Run a shell command that requires root privileges (local variant).
 *
 * If already running as root, executes directly. Otherwise uses
 * @clack/prompts to ask the user to either run with sudo, get the
 * command printed for manual execution, or skip.
 */
async function localWithElevation(
  command: string,
  description: string,
  options?: { sensitive?: boolean },
): Promise<ElevationResult> {
  const sensitive = options?.sensitive ?? false;

  if (isRoot()) {
    const result = await localRun(["sh", "-c", command]);
    return {
      success: result.ok,
      output: result.output,
      skipped: false,
    };
  }

  const menuOptions: { value: string; label: string }[] = [
    { value: "sudo", label: "Run with sudo" },
  ];
  if (!sensitive) {
    menuOptions.push({ value: "print", label: "Show me the command (I'll run it myself)" });
  }
  menuOptions.push({ value: "skip", label: "Skip" });

  const action = await p.select({
    message: `${pc.yellow(description)} requires elevated privileges.`,
    options: menuOptions,
  });

  if (p.isCancel(action)) {
    p.cancel("Cancelled.");
    return { success: false, output: "", skipped: true };
  }

  if (action === "sudo") {
    // Reset terminal state after clack's interactive prompt so
    // sudo's password prompt is visible on the TTY.
    process.stderr.write("\x1b[?25h\x1b[0m");
    p.log.step(pc.dim("Enter your sudo password when prompted:"));

    if (sensitive) {
      // Capture stdout to prevent secret values from leaking to the terminal.
      // sudo prompts on /dev/tty, so stdin/stderr inheritance is sufficient.
      // We must pause/resume stdin around the child process (same as
      // localRunInteractive) to prevent Bun from leaving the stream in an
      // ended state, which would cause all subsequent clack prompts to
      // immediately resolve with EOF and silently exit the CLI.
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();

      const proc = Bun.spawn(["sudo", "sh", "-c", command], {
        stdin: "inherit",
        stdout: "pipe",
        stderr: "inherit",
      });
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
      ]);

      process.stdin.resume();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }

      return {
        success: exitCode === 0,
        output: stdout,
        skipped: false,
      };
    }

    const result = await localRunInteractive(["sudo", "sh", "-c", command]);
    return {
      success: result.ok,
      output: result.output,
      skipped: false,
    };
  }

  if (action === "print") {
    p.log.info(`Run manually:\n  ${pc.cyan(`sudo sh -c '${command}'`)}`);
    // Wait for user to confirm they've run it before continuing
    const done = await p.confirm({
      message: "Have you run the command?",
      initialValue: true,
    });
    if (p.isCancel(done) || !done) {
      return { success: false, output: "", skipped: true };
    }
    return { success: true, output: "", skipped: false };
  }

  return { success: false, output: "", skipped: true };
}

// ─── Host interface ─────────────────────────────────────────────────────────

export interface Host {
  /** Whether this host is accessed over SSH (vs. local). */
  readonly isRemote: boolean;

  /** Execute a command, returning a structured result. */
  run(args: string[]): Promise<RunResult>;

  /**
   * Execute a raw shell command string on the host.
   * Unlike `run()`, the command is NOT escaped. Shell expansion ($HOME, pipes, etc.) works.
   */
  runShell(command: string): Promise<RunResult>;

  /**
   * Run a shell command that requires root privileges.
   * May prompt the user for sudo, show the command, or skip.
   *
   * When `sensitive` is true the command involves secret values:
   * - The sudo path captures stdout instead of inheriting it (prevents terminal leaks)
   * - The "show command" option is hidden (prevents printing secrets)
   */
  withElevation(command: string, description: string, options?: { sensitive?: boolean }): Promise<ElevationResult>;

  /**
   * Read a file, returning its content or null if not found / not accessible.
   */
  readFile(path: string): Promise<string | null>;

  /** Return true if the path exists on this host. */
  fileExists(path: string): Promise<boolean>;

  /**
   * Upload a local file to this host at destPath.
   * Returns the effective path of the file on the host.
   * For LocalHost this is a no-op and returns localPath unchanged.
   */
  uploadFile(localPath: string, destPath: string): Promise<string>;

  /**
   * Download a file from a URL to destPath on this host.
   * For LocalHost uses fetch(). For RemoteHost uses curl over SSH.
   */
  downloadFile(url: string, destPath: string): Promise<void>;

  /**
   * Verify a file's SHA256 checksum on this host.
   * Returns true if the hash matches.
   */
  verifySha256(filePath: string, expectedHash: string): Promise<boolean>;

  /**
   * Compute the SHA256 hash of a file on this host.
   * Returns the hex hash string, or null if the file doesn't exist or the operation fails.
   */
  computeSha256(filePath: string): Promise<string | null>;

  /**
   * Get the CPU architecture of this host (Node.js-style: "x64", "arm64").
   */
  getArch(): Promise<string>;

  /**
   * Open an SSH tunnel so that a service URL (e.g. postgres://localhost:5432)
   * on the remote host becomes reachable from the local machine.
   *
   * For LocalHost this is a no-op, returns the URL unchanged.
   * For RemoteHost this sets up SSH local port forwarding.
   *
   * Returns the rewritten URL and a cleanup function to tear down the tunnel.
   */
  openTunnel(url: string): Promise<{ localUrl: string; close: () => Promise<void> }>;
}

// ─── Convenience helpers ─────────────────────────────────────────────────────

/**
 * Check whether a command exists on the given host.
 *
 * Uses `command -v` first, then falls back to checking common user-local
 * bin directories that may not be in PATH during non-interactive SSH
 * sessions (e.g. ~/.bun/bin, ~/.local/bin, ~/.cargo/bin).
 * Done in a single shell invocation to minimise SSH round-trips.
 */
export async function commandExistsOn(host: Host, name: string): Promise<boolean> {
  const result = await host.runShell(
    `command -v ${name} || test -x "$HOME/.bun/bin/${name}" || test -x "$HOME/.local/bin/${name}" || test -x "$HOME/.cargo/bin/${name}" || test -x "/usr/local/bin/${name}"`,
  );
  return result.ok;
}

/** Check whether a systemd unit is active on the given host. */
export async function isUnitActiveOn(host: Host, unit: string): Promise<boolean> {
  return (await host.run(["systemctl", "is-active", unit])).ok;
}

/** Get the systemd unit state string on the given host. */
export async function getUnitStatusOn(host: Host, unit: string): Promise<string> {
  return (await host.run(["systemctl", "is-active", unit])).output;
}

// ─── LocalHost ───────────────────────────────────────────────────────────────

export class LocalHost implements Host {
  readonly isRemote = false;

  async run(args: string[]): Promise<RunResult> {
    return localRun(args);
  }

  async runShell(command: string): Promise<RunResult> {
    return localRun(["sh", "-c", command]);
  }

  async withElevation(command: string, description: string, options?: { sensitive?: boolean }): Promise<ElevationResult> {
    return localWithElevation(command, description, options);
  }

  async readFile(path: string): Promise<string | null> {
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }

  async fileExists(path: string): Promise<boolean> {
    return existsSync(path);
  }

  /** No-op: caller already has the file at localPath on the local filesystem. */
  async uploadFile(localPath: string, _destPath: string): Promise<string> {
    return localPath;
  }

  async downloadFile(url: string, destPath: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await Bun.write(destPath, bytes);
  }

  async verifySha256(filePath: string, expectedHash: string): Promise<boolean> {
    const hash = await this.computeSha256(filePath);
    return hash === expectedHash;
  }

  async computeSha256(filePath: string): Promise<string | null> {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const hasher = new Bun.CryptoHasher("sha256");
    for await (const chunk of file.stream()) {
      hasher.update(chunk);
    }
    return hasher.digest("hex");
  }

  async getArch(): Promise<string> {
    return process.arch;
  }

  async openTunnel(url: string): Promise<{ localUrl: string; close: () => Promise<void> }> {
    return { localUrl: url, close: async () => {} };
  }
}

export function createLocalHost(): Host {
  return new LocalHost();
}
