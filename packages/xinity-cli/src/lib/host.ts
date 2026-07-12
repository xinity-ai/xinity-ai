/**
 * Host abstraction for command execution via SSH.
 *
 * All operations that touch the filesystem or run commands go through a Host
 * instance. Use `connectHost()` from remote-host.ts to create one.
 */
// ─── Low-level shell primitives ─────────────────────────────────────────────

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

// stdin must not be inherited: Bun corrupts process.stdin when the child exits,
// silently killing the next clack prompt. sudo reads its password from /dev/tty.
export async function localRunInteractive(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  resetStdin();

  return {
    ok: exitCode === 0,
    output: "",
    exitCode,
  };
}

function resetStdin(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.resume();
}

// ─── Elevation (sudo) ──────────────────────────────────────────────────────

export interface ElevationResult {
  success: boolean;
  output: string;
}

// ─── Host interface ─────────────────────────────────────────────────────────

export interface Host {
  /** Execute a command, returning a structured result. */
  run(args: string[]): Promise<RunResult>;

  /**
   * Execute a raw shell command string on the host.
   * Unlike `run()`, the command is NOT escaped. Shell expansion ($HOME, pipes, etc.) works.
   */
  runShell(command: string): Promise<RunResult>;

  /**
   * Run a shell command as root. Uses the established sudo session,
   * prompting for the password once on first need (no-op when root).
   */
  withElevation(command: string, description: string): Promise<ElevationResult>;

  /**
   * Establish root privileges up front: passes silently when already root,
   * otherwise starts the sudo session (one password prompt) so everything
   * after runs unattended. Returns false when authentication is cancelled
   * or fails.
   */
  prepareElevation(): Promise<boolean>;

  /** Read a file, returning its content or null if not found / not accessible. */
  readFile(path: string): Promise<string | null>;

  /** Return true if the path exists on this host. */
  fileExists(path: string): Promise<boolean>;

  /**
   * Upload a local file to this host at destPath.
   * Returns the effective path of the file on the host.
   * For localhost this is a no-op and returns localPath unchanged.
   */
  uploadFile(localPath: string, destPath: string): Promise<string>;

  /** Download a file from a URL to destPath on this host. */
  downloadFile(url: string, destPath: string): Promise<void>;

  /** Verify a file's SHA256 checksum on this host. Returns true if the hash matches. */
  verifySha256(filePath: string, expectedHash: string): Promise<boolean>;

  /**
   * Compute the SHA256 hash of a file on this host.
   * Returns the hex hash string, or null if the file doesn't exist.
   */
  computeSha256(filePath: string): Promise<string | null>;

  /** Get the CPU architecture of this host (Node.js-style: "x64", "arm64"). */
  getArch(): Promise<string>;

  /**
   * Open a tunnel so that a service URL (e.g. postgres://remotehost:5432)
   * becomes reachable from the local machine via SSH port forwarding.
   * For localhost this is a no-op (services are already reachable).
   *
   * Returns the rewritten URL and a cleanup function to tear down the tunnel.
   */
  openTunnel(url: string): Promise<{ localUrl: string; close: () => Promise<void> }>;

  /** Release any long-lived resources (persistent sessions, connections). */
  dispose(): Promise<void>;
}

export interface ReadSecretsResult {
  secrets: Record<string, string>;
  permissionDenied: boolean;
}

/**
 * Read multiple secret files from a directory, elevating if necessary.
 *
 * Tries an unelevated read first for each key. Any that fail (permission
 * denied) are batch-read via a single `withElevation` call.
 */
export async function readSecrets(
  host: Host,
  dir: string,
  keys: string[],
  description: string,
): Promise<ReadSecretsResult> {
  const secrets: Record<string, string> = {};

  for (const key of keys) {
    const content = await host.readFile(`${dir}/${key}`);
    if (content !== null) {
      secrets[key] = content.trim();
    }
  }

  const missing = keys.filter((k) => !(k in secrets));
  if (missing.length === 0) {
    return { secrets, permissionDenied: false };
  }

  const script = missing
    .map((k) => `[ -f '${dir}/${k}' ] && printf '%s\\0%s\\0' '${k}' "$(cat '${dir}/${k}')"`)
    .join("; ") + "; true";

  const result = await host.withElevation(script, description);

  if (!result.success) {
    return { secrets, permissionDenied: true };
  }

  const parts = result.output.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const key = parts[i];
    const value = parts[i + 1];
    if (key && value !== undefined) {
      secrets[key] = value.trim();
    }
  }

  return { secrets, permissionDenied: false };
}

// ─── Convenience helpers ─────────────────────────────────────────────────────

export const COMMAND_FALLBACK_BIN_DIRS = [
  "$HOME/.bun/bin",
  "$HOME/.local/bin",
  "$HOME/.cargo/bin",
  "/usr/local/bin",
];

export async function commandExistsOn(host: Host, name: string): Promise<boolean> {
  const fallbacks = COMMAND_FALLBACK_BIN_DIRS.map((dir) => `test -x "${dir}/${name}"`).join(" || ");
  const result = await host.runShell(`command -v ${name} || ${fallbacks}`);
  return result.ok;
}

export async function isUnitActiveOn(host: Host, unit: string): Promise<boolean> {
  return (await host.run(["systemctl", "is-active", unit])).ok;
}

export async function getUnitStatusOn(host: Host, unit: string): Promise<string> {
  return (await host.run(["systemctl", "is-active", unit])).output;
}
