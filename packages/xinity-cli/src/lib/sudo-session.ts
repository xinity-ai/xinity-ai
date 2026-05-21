/**
 * Persistent sudo shell session over SSH.
 *
 * Keeps a single `ssh host "sudo -S sh"` process alive for the duration of
 * the CLI session. Commands are piped through stdin with delimiter-based
 * output parsing, so the user only authenticates once.
 */
import type { ReadableStreamReader, Subprocess } from "bun";
import { localRun } from "./host.ts";

const AUTH_TIMEOUT_MS = 15_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 3000;
const AUTH_MARKER = "__SUDO_AUTH_OK__";

/**
 * Wraps stream.getReader() with an explicit cast to the default-reader signature.
 * Bun's subprocess streams are standard ReadableStreams, but @types/node's
 * overload resolution can pick the BYOB reader signature (which requires a
 * view argument) instead of the default reader (which takes none).
 */
function getStreamReader(stream: ReadableStream<Uint8Array>): ReadableStreamReader<Uint8Array> {
  return stream.getReader() as ReadableStreamReader<Uint8Array>;
}

type StdinWriter = { write(data: Uint8Array): void; flush(): void; end(): void };

function getStdinWriter(proc: Subprocess): StdinWriter {
  return proc.stdin as unknown as StdinWriter;
}

const encoder = new TextEncoder();

function writeAndFlush(proc: Subprocess, data: string): void {
  const writer = getStdinWriter(proc);
  writer.write(encoder.encode(data));
  writer.flush();
}

type ReadResult = { done: boolean; value?: Uint8Array };

/**
 * Read the next chunk from a stream, racing against a fixed deadline.
 * Returns null on timeout (deadline already passed or new chunk didn't arrive in time).
 */
async function readBeforeDeadline(
  reader: ReadableStreamReader<Uint8Array>,
  deadline: number,
): Promise<ReadResult | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  return await Promise.race([
    reader.read() as Promise<ReadResult>,
    new Promise<null>((r) => setTimeout(() => r(null), remaining)),
  ]);
}

export class SudoSession {
  private proc: Subprocess;
  private stdout: ReadableStreamReader<Uint8Array>;
  private buffer = "";
  private dead = false;
  private decoder = new TextDecoder();

  private stderrReader: ReadableStreamReader<Uint8Array> | null = null;

  private constructor(proc: Subprocess) {
    this.proc = proc;
    this.stdout = getStreamReader(proc.stdout as ReadableStream<Uint8Array>);
    this.stderrReader = proc.stderr ? getStreamReader(proc.stderr as ReadableStream<Uint8Array>) : null;

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

    // Wait for sudo's password prompt on stderr before sending the password.
    // Without this, the password can arrive before sudo is ready to read stdin,
    // causing it to be lost or misinterpreted.
    if (password) {
      await session.waitForSudoPrompt();
    }

    // Send password (even if empty, the newline triggers sudo to proceed).
    writeAndFlush(proc, password + "\n");

    // Switch stderr to background drain now that the prompt has passed.
    session.drainStderr();

    // Probe whether authentication succeeded.
    writeAndFlush(proc, `echo ${AUTH_MARKER}\n`);

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

    // `< /dev/null` stops the command consuming our stdin pipe, `2>&1` merges stderr for unified capture,
    // and the leading `\n` in printf guarantees the delimiter lands on its own line regardless of whether
    // the command output ended with a newline.
    const wrapped =
      `( ${command} ) < /dev/null 2>&1; __xrc=$?\n` +
      `printf '\\n${delimiter}%s\\n' "$__xrc"\n`;

    writeAndFlush(this.proc, wrapped);

    // Read until we see the delimiter line.
    return this.readUntilDelimiter(delimiter);
  }

  async close(): Promise<void> {
    if (this.dead) return;
    try {
      const writer = getStdinWriter(this.proc);
      writer.write(encoder.encode("exit\n"));
      writer.end();
    } catch {
      // stdin may already be closed
    }

    // Give it a moment to exit gracefully, then force-kill.
    const exited = Promise.race([
      this.proc.exited,
      new Promise((r) => setTimeout(r, GRACEFUL_EXIT_TIMEOUT_MS)),
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

  /**
   * Wait for sudo's password prompt to appear on stderr.
   * Sudo writes "[sudo] password for <user>:" (or similar) to stderr
   * before reading the password from stdin. We wait for this to ensure
   * the password isn't sent before sudo is ready to read it.
   */
  private async waitForSudoPrompt(): Promise<void> {
    if (!this.stderrReader) return;
    const decoder = new TextDecoder();
    let stderrBuf = "";
    const deadline = Date.now() + AUTH_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const result = await readBeforeDeadline(this.stderrReader, deadline);
      if (result === null || result.done) break;

      stderrBuf += decoder.decode(result.value!, { stream: true });
      // Sudo prompts typically end with ": " (e.g. "[sudo] password for user: ")
      if (stderrBuf.includes(": ")) return;
    }
  }

  /** Drain remaining stderr in the background so it never blocks. */
  private drainStderr(): void {
    if (!this.stderrReader) return;
    const reader = this.stderrReader;
    const drain = async () => {
      try {
        while (true) {
          const { done } = await reader.read();
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
      const result = await readBeforeDeadline(this.stdout, deadline);
      if (result === null) break;
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
