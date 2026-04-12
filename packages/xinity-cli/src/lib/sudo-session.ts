/**
 * Persistent sudo shell session over SSH.
 *
 * Keeps a single `ssh host "sudo -S sh"` process alive for the duration of
 * the CLI session. Commands are piped through stdin with delimiter-based
 * output parsing, so the user only authenticates once.
 */
import { localRun } from "./host.ts";

const AUTH_TIMEOUT_MS = 15_000;
const AUTH_MARKER = "__SUDO_AUTH_OK__";

export class SudoSession {
  private proc: import("bun").Subprocess;
  private stdout: AsyncIterableIterator<Uint8Array> & { read(): Promise<{ done: boolean; value?: Uint8Array }> };
  private buffer = "";
  private dead = false;
  private decoder = new TextDecoder();

  private constructor(proc: import("bun").Subprocess) {
    this.proc = proc;
    // Cast to a simpler type to avoid Bun's ReadableStreamDefaultReader
    // requiring a pre-allocated buffer argument.
    this.stdout = (proc.stdout as ReadableStream<Uint8Array>).getReader() as any;

    // Watch for unexpected death.
    proc.exited.then(() => {
      this.dead = true;
    });
  }

  get isAlive(): boolean {
    return !this.dead;
  }

  /**
   * Open a persistent sudo shell on a remote host.
   *
   * For passwordless sudo pass an empty string as `password`.
   */
  static async create(
    ctrlArgs: string[],
    hostname: string,
    password: string,
  ): Promise<SudoSession> {
    // -S: read password from stdin instead of /dev/tty.
    // Sudo's password prompt goes to stderr, which we drain in the background.
    const proc = Bun.spawn(
      [
        "ssh",
        ...ctrlArgs,
        hostname,
        "sudo -S sh",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );

    const session = new SudoSession(proc);

    // Drain stderr in the background so it never blocks.
    session.drainStderr();

    // Send password (even if empty, the newline triggers sudo to proceed).
    const writer = proc.stdin as unknown as { write(data: Uint8Array): void; flush(): void };
    writer.write(new TextEncoder().encode(password + "\n"));
    writer.flush();

    // Probe whether authentication succeeded.
    writer.write(new TextEncoder().encode(`echo ${AUTH_MARKER}\n`));
    writer.flush();

    const ok = await session.waitForMarker(AUTH_MARKER, AUTH_TIMEOUT_MS);
    if (!ok) {
      await session.close();
      throw new Error("Sudo authentication failed (wrong password or sudo not available).");
    }

    // Verify we're actually root. If sudo silently failed or dropped
    // privileges, this catches it before the caller runs any commands.
    const verify = await session.execute("id -u");
    if (verify.output.trim() !== "0") {
      await session.close();
      throw new Error(
        `Sudo session is not running as root (id -u returned "${verify.output.trim()}").`,
      );
    }

    return session;
  }

  /**
   * Execute a shell command inside the persistent sudo session.
   * Returns captured output (stdout + stderr merged) and the exit code.
   */
  async execute(command: string): Promise<{ exitCode: number; output: string }> {
    if (this.dead) {
      throw new Error("Sudo session is no longer alive.");
    }

    const delimiter = `__XINITY_END_${crypto.randomUUID().replace(/-/g, "")}__`;

    // Wrap the command so it cannot consume our stdin pipe, and merge
    // stderr into stdout for unified capture. We store the exit code in a
    // variable first, then echo the delimiter on its own line so that it
    // is always on a clean line even if the command output lacks a
    // trailing newline.
    // Store exit code in a variable, ensure a trailing newline, then print
    // the delimiter with the exit code on a clean line. Using printf avoids
    // echo's inconsistent newline handling across shells.
    const wrapped =
      `( ${command} ) < /dev/null 2>&1; __xrc=$?\n` +
      `printf '\\n${delimiter}%s\\n' "$__xrc"\n`;

    const writer = this.proc.stdin as unknown as { write(data: Uint8Array): void; flush(): void };
    writer.write(new TextEncoder().encode(wrapped));
    writer.flush();

    // Read until we see the delimiter line.
    return this.readUntilDelimiter(delimiter);
  }

  async close(): Promise<void> {
    if (this.dead) return;
    try {
      const writer = this.proc.stdin as unknown as { write(data: Uint8Array): void; end(): void };
      writer.write(new TextEncoder().encode("exit\n"));
      writer.end();
    } catch {
      // stdin may already be closed
    }

    // Give it a moment to exit gracefully, then force-kill.
    const exited = Promise.race([
      this.proc.exited,
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    await exited;
    try {
      this.proc.kill();
    } catch {
      // already dead
    }
    this.dead = true;
  }

  // -- internal helpers -------------------------------------------------------

  private drainStderr(): void {
    const stderr = (this.proc.stderr as ReadableStream<Uint8Array>)?.getReader();
    if (!stderr) return;
    const drain = async () => {
      try {
        while (true) {
          const { done } = await stderr.read();
          if (done) break;
        }
      } catch {
        // ignore
      }
    };
    drain();
  }

  private async waitForMarker(marker: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const chunk = await Promise.race([
        this.stdout.read(),
        new Promise<null>((r) => setTimeout(() => r(null), remaining)),
      ]);

      if (chunk === null) break; // timed out
      const result = chunk as { done: boolean; value?: Uint8Array };
      if (result.done) {
        this.dead = true;
        break;
      }

      this.buffer += this.decoder.decode(result.value!, { stream: true });

      if (this.buffer.includes(marker)) {
        // Consume everything up to and including the marker line.
        const idx = this.buffer.indexOf(marker);
        const afterMarker = this.buffer.indexOf("\n", idx);
        this.buffer = afterMarker >= 0 ? this.buffer.slice(afterMarker + 1) : "";
        return true;
      }
    }
    return false;
  }

  private async readUntilDelimiter(
    delimiter: string,
  ): Promise<{ exitCode: number; output: string }> {
    while (true) {
      // Check buffer for delimiter.
      const delimIdx = this.buffer.indexOf(delimiter);
      if (delimIdx >= 0) {
        const output = this.buffer.slice(0, delimIdx).replace(/\n+$/, "");
        const afterDelim = this.buffer.indexOf("\n", delimIdx);
        const markerLine = afterDelim >= 0
          ? this.buffer.slice(delimIdx, afterDelim)
          : this.buffer.slice(delimIdx);
        this.buffer = afterDelim >= 0 ? this.buffer.slice(afterDelim + 1) : "";

        const exitCode = parseInt(markerLine.slice(delimiter.length), 10);
        return { exitCode: Number.isNaN(exitCode) ? 1 : exitCode, output };
      }

      // Read more data.
      const { done, value } = await this.stdout.read();
      if (done) {
        this.dead = true;
        throw new Error("Sudo session died while waiting for command output.");
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
}

/**
 * Check whether the remote user can run sudo without a password.
 * This should only be called AFTER the user has agreed to use sudo.
 */
export async function checkPasswordlessSudo(
  ctrlArgs: string[],
  hostname: string,
): Promise<boolean> {
  const result = await localRun([
    "ssh", ...ctrlArgs, hostname,
    "sudo -n true 2>/dev/null",
  ]);
  return result.ok;
}
