import { getAvailablePort, readProcessOutput, waitForHttp } from "../test-helpers";
export { getAvailablePort };

const HOST = process.env.INFOSERVER_HOST ?? "127.0.0.1";
const MODEL_INFO_DIR = process.env.MODEL_INFO_DIR ?? "./models.d";
const MODEL_LEGACY_DIR = process.env.MODEL_LEGACY_DIR ?? "./models.legacy.d";

let allocatedPort: string | null = null;
let infoProcess: Bun.Subprocess | null = null;
let infoReady: Promise<void> | null = null;

/** Starts the info server once and waits for its health endpoint. */
export async function ensureInfoServerRunning(): Promise<void> {
  if (infoReady && infoProcess) {
    const alive = !infoProcess.killed && infoProcess.exitCode === null;
    if (alive) return infoReady;
    infoProcess = null;
    infoReady = null;
  }

  infoReady = (async () => {
    const port = process.env.INFOSERVER_PORT ?? String(await getAvailablePort());
    allocatedPort = port;

    infoProcess = Bun.spawn([
      "bun",
      "run",
      "server.ts",
    ], {
      cwd: "packages/xinity-infoserver",
      env: {
        ...process.env,
        HOST,
        PORT: port,
        MODEL_INFO_DIR,
        MODEL_LEGACY_DIR,
        // Lets each test present its own client address, so one test spending a
        // rate-limit bucket cannot throttle the next.
        HTTP_IP_HEADER: "x-forwarded-for",
        HTTP_XFF_DEPTH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const healthUrl = `http://${HOST}:${port}/health`;    
    const healthWait = waitForHttp(healthUrl, { timeoutMs: 20_000 });
    const exitWait = infoProcess.exited.then(async (code) => {
      const output = await readProcessOutput(infoProcess!);
      throw new Error(
        `Info server exited before health check (code ${code}). stderr: ${output.stderr || "<empty>"}`
      );
    });
    await Promise.race([healthWait, exitWait]);
  })();

  return infoReady;
}

/** Stops the info server process with a SIGTERM/SIGKILL fallback. */
export async function stopInfoServer(): Promise<void> {
  if (!infoProcess) {
    return;
  }
  const exited = infoProcess.exited;
  infoProcess.kill();
  const timeout = Bun.sleep(2000) 
  await Promise.race([exited.then(() => undefined), timeout]);
  const didExit = await Promise.race([exited.then(() => true), Promise.resolve(false)]);
  if (!didExit) {
    try {
      infoProcess.kill("SIGKILL");
    } catch {
      // ignore if already exited
    }
    await infoProcess.exited;
  }
  infoProcess = null;
  infoReady = null;
}

/**
 * Runs a throwaway instance with its own environment, for behaviour that depends
 * on how the server is configured rather than on catalog contents. Keys set to
 * undefined are removed, so an inherited value cannot leak in.
 */
export async function withInfoServer<T>(
  overrides: Record<string, string | undefined>,
  body: (url: (path: string) => string) => Promise<T>,
): Promise<T> {
  const port = String(await getAvailablePort());
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOST,
    PORT: port,
    MODEL_INFO_DIR,
    MODEL_LEGACY_DIR,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const proc = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: "packages/xinity-infoserver",
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await Promise.race([
      waitForHttp(`http://${HOST}:${port}/health`, { timeoutMs: 20_000 }),
      proc.exited.then(async (code) => {
        const output = await readProcessOutput(proc);
        throw new Error(`Info server exited before health check (code ${code}). stderr: ${output.stderr || "<empty>"}`);
      }),
    ]);
    return await body(path => `http://${HOST}:${port}${path}`);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

/** Builds an info server URL for the configured host/port. */
export function infoServerUrl(path: string): string {
  if (!allocatedPort) throw new Error("Info server not started yet, call ensureInfoServerRunning() first");
  return `http://${HOST}:${allocatedPort}${path}`;
}

