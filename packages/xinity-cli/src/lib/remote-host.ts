import { localRun, localRunInteractive, type Host, type RunResult, type ElevationResult, type ElevationPolicy } from "./host.ts";
import * as p from "./clack.ts";
import pc from "picocolors";
import { SudoSession, checkPasswordlessSudo } from "./sudo-session.ts";

function sanitizeHost(hostname: string): string {
  return hostname.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Read a password from the terminal with echo fully disabled.
 *
 * Handles raw keystrokes manually so backspace works while revealing
 * nothing about the input (no mask characters, no length indication).
 * Returns null on Ctrl-C / Ctrl-D.
 */
async function readSudoPassword(prompt: string): Promise<string | null> {
  // Drain any stale keystrokes left in stdin from previous prompts (e.g. clack menus).
  // Without this, a buffered Enter from the menu confirmation can be read as an
  // immediate empty-password submission.
  await drainStdinBuffer();

  return new Promise((resolve) => {
    process.stderr.write(prompt);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    let buf = "";
    let resolved = false;

    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      process.stdin.removeListener("data", onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stderr.write("\n");
      resolve(value);
    };

    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 0x03 || byte === 0x04) {
          return finish(null);
        }
        if (byte === 0x0D || byte === 0x0A) {
          return finish(buf);
        }
        if (byte === 0x7F || byte === 0x08) {
          buf = buf.slice(0, -1);
        } else if (byte >= 0x20) {
          buf += String.fromCharCode(byte);
        }
      }
    };

    process.stdin.on("data", onData);
  });
}

/** Consume any bytes already sitting in the stdin buffer (e.g. from prior prompts). */
function drainStdinBuffer(): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Read and discard any immediately available data
    const onData = () => {};
    process.stdin.on("data", onData);

    // After a tick, nothing more is buffered - stop draining
    setTimeout(() => {
      process.stdin.removeListener("data", onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      resolve();
    }, 50);
  });
}

export function socketPath(hostname: string): string {
  return `/tmp/xinity-ssh-${sanitizeHost(hostname)}`;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function b64Cmd(command: string): string {
  return Buffer.from(command).toString("base64");
}

export class RemoteHost implements Host {
  readonly isRemote = true;
  private readonly hostname: string;
  private readonly socket: string;
  /** SSH args that enable ControlMaster reuse. Inserted before the host. */
  private readonly ctrlArgs: string[];

  private sudoSession: SudoSession | null = null;
  private isRootCached: boolean | null = null;
  private elevationPolicy: ElevationPolicy = null;

  constructor(hostname: string) {
    this.hostname = hostname;
    this.socket = socketPath(hostname);
    this.ctrlArgs = [
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${this.socket}`,
      "-o", "ControlPersist=yes",
    ];
  }

  async connect(): Promise<void> {
    // Kill any stale control socket from a previous CLI run. Reusing a stale
    // socket can corrupt stdin piping for sudo sessions.
    await localRun(["ssh", "-O", "exit", ...this.ctrlArgs, this.hostname]).catch(() => {});

    const result = await localRun([
      "ssh",
      ...this.ctrlArgs,
      "-o", "BatchMode=no", // allow interactive auth (key passphrase / password)
      this.hostname,
      "echo xinity-connected",
    ]);

    if (!result.ok || !result.output.includes("xinity-connected")) {
      throw new Error(
        `Could not connect to ${this.hostname}: ${result.output || "SSH connection failed"}`,
      );
    }
  }

  async run(args: string[]): Promise<RunResult> {
    const remoteCmd = args.map(shellEscape).join(" ");
    return localRun(["ssh", ...this.ctrlArgs, this.hostname, remoteCmd]);
  }

  async runShell(command: string): Promise<RunResult> {
    return localRun(["ssh", ...this.ctrlArgs, this.hostname, command]);
  }

  async withElevation(command: string, description: string, options?: { sensitive?: boolean }): Promise<ElevationResult> {
    const sensitive = options?.sensitive ?? false;

    // Cache the root check so we don't run `id -u` on every call.
    if (this.isRootCached === null) {
      const whoami = await localRun(["ssh", ...this.ctrlArgs, this.hostname, "id -u"]);
      this.isRootCached = whoami.ok && whoami.output.trim() === "0";
    }

    if (this.isRootCached) {
      const b64 = b64Cmd(command);
      const result = await localRun([
        "ssh", ...this.ctrlArgs, this.hostname,
        `echo '${b64}' | base64 -d | sh`,
      ]);
      return { success: result.ok, output: result.output, skipped: false };
    }

    // Apply remembered policy if set.
    if (this.elevationPolicy === "sudo") {
      p.log.step(pc.dim(description));
      return this.executeViaSudoSession(command);
    }
    if (this.elevationPolicy === "manual" && !sensitive) {
      p.log.step(pc.dim(description));
      this.showManualCommand(command);
      return this.confirmManualRun();
    }

    // First time (or sensitive command with manual policy): show menu.
    const menuOptions: { value: string; label: string }[] = [
      { value: "sudo-all", label: "Run with sudo (all remaining)" },
      { value: "sudo-once", label: "Run with sudo (this time only)" },
    ];
    if (!sensitive) {
      menuOptions.push(
        { value: "manual-all", label: "Show me the commands (all remaining)" },
        { value: "manual-once", label: "Show me the command (this time only)" },
      );
    }

    const action = await p.select({
      message: `${pc.yellow(description)} requires elevated privileges on ${pc.cyan(this.hostname)}.`,
      options: menuOptions,
    });

    if (p.isCancel(action)) {
      p.cancel("Cancelled.");
      return { success: false, output: "", skipped: true };
    }

    if (action === "sudo-all" || action === "sudo-once") {
      if (action === "sudo-all") this.elevationPolicy = "sudo";
      return this.ensureSudoSessionAndExecute(command);
    }

    if (action === "manual-all" || action === "manual-once") {
      if (action === "manual-all") this.elevationPolicy = "manual";
      this.showManualCommand(command);
      return this.confirmManualRun();
    }

    return { success: false, output: "", skipped: true };
  }

  async dispose(): Promise<void> {
    if (this.sudoSession) {
      await this.sudoSession.close();
      this.sudoSession = null;
    }
  }

  // -- sudo session helpers ---------------------------------------------------

  private async ensureSudoSessionAndExecute(command: string): Promise<ElevationResult> {
    if (!this.sudoSession || !this.sudoSession.isAlive) {
      this.sudoSession = null;

      // Check if passwordless sudo is available.
      const passwordless = await checkPasswordlessSudo(this.ctrlArgs, this.hostname);

      if (passwordless) {
        try {
          this.sudoSession = await SudoSession.create(this.ctrlArgs, this.hostname, "");
          p.log.success("Passwordless sudo detected.");
        } catch (err) {
          p.log.warn(`Failed to establish sudo session: ${(err as Error).message}`);
          this.elevationPolicy = null;
          return { success: false, output: "", skipped: false };
        }
      } else {
        // Prompt for password with up to 3 attempts. The fixed-length mask
        // prevents leaking the password length via the terminal output.
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const input = await readSudoPassword(
            attempt === 1
              ? `Sudo password for ${pc.cyan(this.hostname)}: `
              : `Wrong password. Try again (${attempt}/${MAX_ATTEMPTS}): `,
          );
          if (input === null) {
            p.cancel("Cancelled.");
            return { success: false, output: "", skipped: true };
          }

          try {
            this.sudoSession = await SudoSession.create(this.ctrlArgs, this.hostname, input);
            p.log.success("Sudo session established.");
            break;
          } catch {
            if (attempt === MAX_ATTEMPTS) {
              p.log.error("Failed to authenticate after 3 attempts.");
              this.elevationPolicy = null;
              return { success: false, output: "", skipped: false };
            }
          }
        }
      }
    }

    return this.executeViaSudoSession(command);
  }

  private async executeViaSudoSession(command: string): Promise<ElevationResult> {
    if (!this.sudoSession || !this.sudoSession.isAlive) {
      // Session died, try to re-establish.
      return this.ensureSudoSessionAndExecute(command);
    }

    try {
      const { exitCode, output } = await this.sudoSession.execute(command);
      return { success: exitCode === 0, output, skipped: false };
    } catch (err) {
      p.log.warn(`Sudo session error: ${(err as Error).message}`);
      this.sudoSession = null;
      return { success: false, output: "", skipped: false };
    }
  }

  private showManualCommand(command: string): void {
    const b64 = b64Cmd(command);
    p.log.info(
      `Run manually on ${pc.cyan(this.hostname)}:\n  ${pc.cyan(`echo '${b64}' | base64 -d | sudo sh`)}`,
    );
    p.log.info(`Or the equivalent plain command:\n  ${pc.dim(command.replace(/\n/g, "\n  "))}`);
  }

  private async confirmManualRun(): Promise<ElevationResult> {
    const done = await p.confirm({ message: "Have you run the command?", initialValue: true });
    if (p.isCancel(done) || !done) {
      const abort = await p.confirm({ message: "Abort?", initialValue: false });
      if (p.isCancel(abort) || abort) {
        p.cancel("Aborted.");
        return { success: false, output: "", skipped: true };
      }
      return { success: false, output: "", skipped: true };
    }
    return { success: true, output: "", skipped: false };
  }

  async readFile(path: string): Promise<string | null> {
    const result = await localRun([
      "ssh", ...this.ctrlArgs, this.hostname,
      `cat ${shellEscape(path)}`,
    ]);
    return result.ok ? result.output : null;
  }

  async fileExists(path: string): Promise<boolean> {
    const result = await localRun([
      "ssh", ...this.ctrlArgs, this.hostname,
      // stat exits 0 when the file exists. If it fails with "Permission denied"
      // the file exists but the current user cannot access it (needs elevation).
      `s=$(stat ${shellEscape(path)} 2>&1) && echo yes || (echo "$s" | grep -qi 'permission denied' && echo perm || echo no)`,
    ]);
    const out = result.output.trim();
    return out === "yes" || out === "perm";
  }

  async uploadFile(localPath: string, destPath: string): Promise<string> {
    const result = await localRun([
      "scp",
      "-o", `ControlPath=${this.socket}`,
      localPath,
      `${this.hostname}:${destPath}`,
    ]);
    if (!result.ok) {
      throw new Error(`Failed to upload ${localPath} to ${this.hostname}:${destPath}: ${result.output}`);
    }
    return destPath;
  }

  async downloadFile(url: string, destPath: string): Promise<void> {
    const result = await localRun([
      "ssh", ...this.ctrlArgs, this.hostname,
      `curl -fsSL -o ${shellEscape(destPath)} ${shellEscape(url)}`,
    ]);
    if (!result.ok) {
      throw new Error(`Remote download failed: ${result.output}`);
    }
  }

  async verifySha256(filePath: string, expectedHash: string): Promise<boolean> {
    const actualHash = await this.computeSha256(filePath);
    return actualHash === expectedHash;
  }

  async computeSha256(filePath: string): Promise<string | null> {
    const result = await localRun([
      "ssh", ...this.ctrlArgs, this.hostname,
      `sha256sum ${shellEscape(filePath)}`,
    ]);
    if (!result.ok) return null;
    // sha256sum output format: "hash  filename"
    const hash = result.output.split(/\s+/)[0];
    return hash || null;
  }

  async getArch(): Promise<string> {
    const result = await localRun([
      "ssh", ...this.ctrlArgs, this.hostname,
      "uname -m",
    ]);
    if (!result.ok) throw new Error(`Failed to detect remote architecture: ${result.output}`);
    const raw = result.output.trim();
    if (raw === "aarch64" || raw === "arm64") return "arm64";
    if (raw === "x86_64" || raw === "amd64") return "x64";
    return raw;
  }

  async openTunnel(url: string): Promise<{ localUrl: string; close: () => Promise<void> }> {
    const parsed = new URL(url);
    const remoteHost = parsed.hostname;
    const remotePort = parsed.port || (parsed.protocol === "redis:" ? "6379" : "5432");

    // Use SSH dynamic port allocation (local port 0 lets SSH pick a free port).
    // -f backgrounds after auth, -o ExitOnForwardFailure=yes ensures we fail fast.
    // SSH writes the allocated port info when using 0 as local port, but we can't
    // easily capture it. Instead, find a free port via the OS.
    const { port: localPort } = await new Promise<{ port: number }>((resolve, reject) => {
      const server = require("net").createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close(() => resolve({ port }));
      });
      server.on("error", reject);
    });

    // Set up SSH local port forwarding using the existing control socket.
    // -f sends SSH to the background after connection, -N means no remote command.
    const fwdResult = await localRun([
      "ssh", "-f", "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-L", `${localPort}:${remoteHost}:${remotePort}`,
      ...this.ctrlArgs,
      this.hostname,
    ]);

    if (!fwdResult.ok) {
      throw new Error(`SSH tunnel failed: ${fwdResult.output}`);
    }

    // Rewrite the URL to point at the local forwarded port
    const localParsed = new URL(url);
    localParsed.hostname = "127.0.0.1";
    localParsed.port = String(localPort);
    const localUrl = localParsed.toString();

    return {
      localUrl,
      close: async () => {
        // Cancel the specific forwarding via the control socket
        await localRun([
          "ssh", "-O", "cancel",
          "-L", `${localPort}:${remoteHost}:${remotePort}`,
          ...this.ctrlArgs,
          this.hostname,
        ]);
      },
    };
  }
}

export async function connectRemoteHost(hostname: string): Promise<RemoteHost> {
  const remote = new RemoteHost(hostname);
  await remote.connect();
  p.log.success(`Connected to ${pc.cyan(hostname)}`);
  return remote;
}
