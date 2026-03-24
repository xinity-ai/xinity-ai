import { localRun, localRunInteractive, type Host, type RunResult, type ElevationResult } from "./host.ts";
import * as p from "./clack.ts";
import pc from "picocolors";

function sanitizeHost(hostname: string): string {
  return hostname.replace(/[^a-zA-Z0-9._-]/g, "_");
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
    // Check if we're already root on the remote
    const whoami = await localRun(["ssh", ...this.ctrlArgs, this.hostname, "id -u"]);
    const isRoot = whoami.ok && whoami.output.trim() === "0";

    if (isRoot) {
      const b64 = b64Cmd(command);
      const result = await localRun([
        "ssh", ...this.ctrlArgs, this.hostname,
        `echo '${b64}' | base64 -d | sh`,
      ]);
      return { success: result.ok, output: result.output, skipped: false };
    }

    // Non-root: offer the same options as the local sudo flow
    const sensitive = options?.sensitive ?? false;
    const menuOptions: { value: string; label: string }[] = [
      { value: "sudo", label: "Run with sudo (on remote)" },
    ];
    if (!sensitive) {
      menuOptions.push({ value: "print", label: "Show me the command (I'll run it myself)" });
    }
    menuOptions.push({ value: "skip", label: "Skip" });

    const action = await p.select({
      message: `${pc.yellow(description)} requires elevated privileges on ${pc.cyan(this.hostname)}.`,
      options: menuOptions,
    });

    if (p.isCancel(action)) {
      p.cancel("Cancelled.");
      return { success: false, output: "", skipped: true };
    }

    if (action === "sudo") {
      process.stderr.write("\x1b[?25h\x1b[0m");
      p.log.step(pc.dim("Enter your sudo password on the remote when prompted:"));

      // We need both a real TTY (for sudo's password prompt) and captured stdout
      // (for callers to read output). We use `ssh -t` with output redirected to a
      // temp file: the redirect is set up by the non-root shell so the file is
      // readable without elevation, while sudo's prompt goes through /dev/tty
      // independently. LogLevel=QUIET suppresses SSH's "connection closed" message
      // (the ControlMaster socket stays alive via ControlPersist=yes).
      const tmpFile = `/tmp/xinity-elev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const b64 = b64Cmd(command);

      // The remote command writes its output to a tmp file and appends an exit-code
      // marker on the last line ("::exit:N"). This lets us distinguish a failed
      // command from a failed SSH connection even when the PTY exit-code path is
      // unreliable (some SSH/OS combinations do not propagate the remote exit code
      // correctly with -t).
      const authResult = await localRunInteractive([
        "ssh", "-t", "-o", "LogLevel=QUIET", ...this.ctrlArgs, this.hostname,
        `echo '${b64}' | base64 -d | sudo sh > '${tmpFile}' 2>&1; echo "::exit::$?" >> '${tmpFile}'`,
      ]);

      if (!authResult.ok) {
        await localRun(["ssh", ...this.ctrlArgs, this.hostname, `rm -f '${tmpFile}'`]);
        p.log.warn("Sudo command failed or authentication was rejected.");
        return { success: false, output: "", skipped: false };
      }

      // Read the captured output, extract the exit-code marker, and clean up.
      const readResult = await localRun([
        "ssh", ...this.ctrlArgs, this.hostname,
        `cat '${tmpFile}'; rm -f '${tmpFile}'`,
      ]);

      const lines = readResult.output.split("\n");
      const markerLine = lines.findLast((l) => l.startsWith("::exit::"));
      const output = lines.filter((l) => !l.startsWith("::exit::")).join("\n").trimEnd();
      const remoteExitCode = markerLine ? parseInt(markerLine.slice(8), 10) : 0;
      const success = remoteExitCode === 0;

      if (!success) {
        p.log.warn(`Remote command exited with code ${remoteExitCode}.`);
      }

      return { success, output, skipped: false };
    }

    if (action === "print") {
      const b64 = b64Cmd(command);
      p.log.info(
        `Run manually on ${pc.cyan(this.hostname)}:\n  ${pc.cyan(`echo '${b64}' | base64 -d | sudo sh`)}`,
      );
      p.log.info(`Or the equivalent plain command:\n  ${pc.dim(command.replace(/\n/g, "\n  "))}`);
      const done = await p.confirm({
        message: "Have you run the command?",
        initialValue: true,
      });
      if (p.isCancel(done) || !done) return { success: false, output: "", skipped: true };
      return { success: true, output: "", skipped: false };
    }

    return { success: false, output: "", skipped: true };
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
      `test -e ${shellEscape(path)} && echo yes || echo no`,
    ]);
    return result.ok && result.output.trim() === "yes";
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
