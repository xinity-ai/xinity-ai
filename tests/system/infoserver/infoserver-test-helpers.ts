import { createServer } from "net";
import { waitForHttp } from "../test-helpers";

const HOST = process.env.INFOSERVER_HOST ?? "127.0.0.1";
const MODEL_INFO_FILE = process.env.MODEL_INFO_FILE ?? "models.yaml";

let allocatedPort: string | null = null;
let infoProcess: Bun.Subprocess | null = null;
let infoReady: Promise<void> | null = null;

async function readProcessOutput(proc: Bun.Subprocess): Promise<{ stdout: string; stderr: string }> {
  const stdout = proc.stdout instanceof ReadableStream ? await new Response(proc.stdout).text() : "";
  const stderr = proc.stderr  instanceof ReadableStream ? await new Response(proc.stderr).text() : "";
  return { stdout, stderr };
}

/** Starts the info server once and waits for its health endpoint. */
export async function ensureInfoServerRunning(): Promise<void> {
  if (infoReady) {
    return infoReady;
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
        MODEL_INFO_FILE,
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

/** Builds an info server URL for the configured host/port. */
export function infoServerUrl(path: string): string {
  if (!allocatedPort) throw new Error("Info server not started yet, call ensureInfoServerRunning() first");
  return `http://${HOST}:${allocatedPort}${path}`;
}

/** Allocates a free local port. */
export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
