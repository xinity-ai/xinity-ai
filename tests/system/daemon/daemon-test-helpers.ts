import { createServer } from "net";
import { aiNodeT, eq, modelInstallationStateT, preconfigureDB } from "common-db";
import { readProcessOutput } from "../test-helpers";
import { ensureInfoServerRunning, infoServerUrl } from "../infoserver/infoserver-test-helpers";
import { ensureSystemReady } from "../guard";

let db: ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;

function getDB() {
  if (!db) {
    const { getDB: init } = preconfigureDB(process.env.DB_CONNECTION_URL!);
    db = init();
  }
  return db;
}

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

export function createTempStateDir(): string {
  const proc = Bun.spawnSync(["mktemp", "-d"]);
  if (proc.exitCode !== 0) {
    throw new Error(`mktemp failed: ${proc.stderr?.toString()}`);
  }
  const dir = proc.stdout?.toString().trim();
  if (!dir) {
    throw new Error("mktemp returned empty path");
  }
  return dir;
}

export async function writeNodeId(stateDir: string, nodeId: string): Promise<void> {
  await Bun.write(`${stateDir}/node_id`, nodeId);
}

export async function startDaemon(options: {
  stateDir: string;
  ollamaEndpoint: string;
  port?: number;
  host?: string;
  syncIntervalMs?: number;
}): Promise<Bun.Subprocess> {
  await ensureSystemReady();

  const port = options.port ?? (await getAvailablePort());
  const host = options.host ?? "127.0.0.1";
  const syncIntervalMs = options.syncIntervalMs ?? 500;

  await ensureInfoServerRunning();

  const DB_CONNECTION_URL = process.env.DB_CONNECTION_URL!;

  const proc = Bun.spawn([
    "bun",
    "run",
    "src/index.ts",
  ], {
    cwd: "packages/xinity-ai-daemon",
    env: {
      ...process.env,
      PORT: String(port),
      HOST: host,
      STATE_DIR: options.stateDir,
      XINITY_OLLAMA_ENDPOINT: options.ollamaEndpoint,
      DB_CONNECTION_URL,
      SYNC_INTERVAL_MS: String(syncIntervalMs),
      INFOSERVER_URL: infoServerUrl(""),
    },
    stdout: "ignore",
    stderr: "pipe",
  });

  // Actively drain stderr to prevent pipe buffer deadlock
  const stderrPromise = proc.stderr instanceof ReadableStream
    ? new Response(proc.stderr).text()
    : Promise.resolve("");

  const exitWait = proc.exited.then(async (code) => {
    const stderr = await stderrPromise;
    throw new Error(
      `Daemon exited unexpectedly (code ${code}). stderr: ${stderr || "<empty>"}`
    );
  });

  await Promise.race([
    waitForNodeIdFile(options.stateDir, 10_000),
    exitWait,
  ]);

  return proc;
}

export async function stopDaemon(proc: Bun.Subprocess): Promise<void> {
  let didExit = false;
  proc.exited.then(() => { didExit = true; });
  proc.kill("SIGTERM");
  await Promise.race([proc.exited.then(() => undefined), Bun.sleep(5000)]);
  if (!didExit) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore if already exited
    }
  }
  await proc.exited;
}

export async function waitForNodeIdFile(stateDir: string, timeoutMs: number): Promise<string> {
  const start = Date.now();
  const path = `${stateDir}/node_id`;
  while (Date.now() - start < timeoutMs) {
    const file = Bun.file(path);
    if (await file.exists()) {
      return (await file.text()).trim();
    }
    await Bun.sleep(100)
  }
  throw new Error("Timed out waiting for node_id file");
}

export async function waitForNodeAvailability(nodeId: string, available: boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [node] = await getDB().select().from(aiNodeT).where(eq(aiNodeT.id, nodeId)).limit(1);
    if (node && node.available === available) {
      return;
    }
    await Bun.sleep(200)
  }
  throw new Error(`Timed out waiting for node ${nodeId} available=${available}`);
}

export async function waitForInstallationState(installationId: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [state] = await getDB()
      .select()
      .from(modelInstallationStateT)
      .where(eq(modelInstallationStateT.id, installationId))
      .limit(1);
    if (state && state.lifecycleState === "ready") {
      return;
    }
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for installation state for ${installationId}`);
}

export type OllamaMock = {
  endpoint: string;
  stop: () => void;
  calls: {
    list: number;
    pull: Array<{ model: string }>;
    delete: Array<{ model: string }>;
  };
  addInstalledModel: (model: string) => void;
};

export async function startMockOllamaServer(): Promise<OllamaMock> {
  const port = await getAvailablePort();
  const installed = new Set<string>();
  const calls = { list: 0, pull: [] as Array<{ model: string }>, delete: [] as Array<{ model: string }> };

  const server = Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/tags") {
        calls.list += 1;
        return Response.json({
          models: Array.from(installed).map((model) => ({
            model,
            name: model,
            size: 1,
            digest: "sha256:test",
            modified_at: new Date().toISOString(),
          })),
        });
      }

      if (req.method === "POST" && url.pathname === "/api/pull") {
        const body = await req.json();
        calls.pull.push({ model: body.name });
        installed.add(body.name);

        const stream = new ReadableStream({
          start(controller) {
            const messages = [
              { status: "pulling", completed: 1, total: 4 },
              { status: "verifying", completed: 4, total: 4 },
              { status: "success" },
            ];
            for (const msg of messages) {
              controller.enqueue(`${JSON.stringify(msg)}\n`);
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: { "content-type": "application/x-ndjson" },
        });
      }

      if (req.method === "DELETE" && url.pathname === "/api/delete") {
        const body = await req.json();
        calls.delete.push({ model: body.name });
        installed.delete(body.name);
        return Response.json({ status: "success" });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    endpoint: `http://127.0.0.1:${port}`,
    stop: () => server.stop(),
    calls,
    addInstalledModel: (model: string) => installed.add(model),
  };
}
