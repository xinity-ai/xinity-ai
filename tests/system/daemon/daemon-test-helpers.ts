import { aiNodeT, modelInstallationT, modelInstallationStateT, preconfigureDB, sql } from "common-db";
import { getAvailablePort } from "../test-helpers";
import { ensureInfoServerRunning, infoServerUrl } from "../infoserver/infoserver-test-helpers";
import { ensureSystemReady } from "../guard";

export { getAvailablePort };

let db: ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;

function getDB() {
  if (!db) {
    const { getDB: init } = preconfigureDB(process.env.DB_CONNECTION_URL!);
    db = init();
  }
  return db;
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

export type TetherMock = {
  endpoint: string;
  stop: () => void;
};

async function startMockTetherServer(): Promise<TetherMock> {
  const port = await getAvailablePort();
  const db = getDB();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname === "/api/v1/stream") {
        const body = await req.json();
        const nodeId = body.nodeId as string;

        await db.insert(aiNodeT).values({
          id: nodeId,
          host: body.host,
          port: body.port,
          estCapacity: body.estCapacity,
          gpuCount: body.gpuCount ?? 0,
          driverVersions: body.driverVersions ?? {},
          driverFeatures: body.driverFeatures ?? {},
          gpus: body.gpus ?? [],
          authToken: body.authToken,
          tls: body.tls ?? false,
          machineName: body.machineName,
          available: true,
        }).onConflictDoUpdate({
          target: aiNodeT.id,
          set: {
            host: body.host,
            port: body.port,
            estCapacity: body.estCapacity,
            gpuCount: body.gpuCount ?? 0,
            driverVersions: body.driverVersions ?? {},
            driverFeatures: body.driverFeatures ?? {},
            gpus: body.gpus ?? [],
            authToken: body.authToken,
            tls: body.tls ?? false,
            machineName: body.machineName,
            available: true,
            deletedAt: null,
          },
        });

        const installations = await db.select()
          .from(modelInstallationT)
          .where(sql`${modelInstallationT.nodeId} = ${nodeId} AND ${modelInstallationT.deletedAt} IS NULL`);

        const desiredState = {
          nodeId,
          installations: installations.map(row => ({
            installationId: row.id,
            specifier: row.specifier,
            driver: row.driver,
            estCapacity: row.estCapacity,
            kvCacheCapacity: row.kvCacheCapacity,
            port: row.port,
            settings: row.settings,
          })),
        };

        const stream = new ReadableStream({
          start(controller) {
            const event = `event: state\ndata: ${JSON.stringify(desiredState)}\n\n`;
            controller.enqueue(new TextEncoder().encode(event));
          },
          async cancel() {
            await db.update(aiNodeT)
              .set({ available: false })
              .where(sql`${aiNodeT.id} = ${nodeId}`);
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/v1/status") {
        const body = await req.json();
        for (const state of body.states) {
          await db.insert(modelInstallationStateT).values({
            id: state.installationId,
            lifecycleState: state.lifecycleState,
            progress: state.progress ?? null,
            errorMessage: state.errorMessage ?? null,
            statusMessage: state.statusMessage ?? null,
            failureLogs: state.failureLogs ?? null,
          }).onConflictDoUpdate({
            target: modelInstallationStateT.id,
            set: {
              lifecycleState: sql`excluded.lifecycle_state`,
              progress: sql`excluded.progress`,
              errorMessage: sql`excluded.error_message`,
              statusMessage: sql`excluded.status_message`,
              failureLogs: sql`excluded.failure_logs`,
            },
          });
        }
        return Response.json({ ok: true });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    endpoint: `http://127.0.0.1:${port}`,
    stop: () => server.stop(),
  };
}

export type DaemonHandle = {
  proc: Bun.Subprocess;
  stopTether: () => void;
};

export async function startDaemon(options: {
  stateDir: string;
  ollamaEndpoint: string;
  port?: number;
  host?: string;
  syncIntervalMs?: number;
}): Promise<DaemonHandle> {
  await ensureSystemReady();

  const port = options.port ?? (await getAvailablePort());
  const host = options.host ?? "127.0.0.1";
  const syncIntervalMs = options.syncIntervalMs ?? 500;

  await ensureInfoServerRunning();

  const tether = await startMockTetherServer();
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
      TETHER_URL: tether.endpoint,
      TETHER_SECRET: "test-secret",
      // Blank so driver detection cannot block on pulling a multi-gigabyte image.
      VLLM_DOCKER_IMAGE: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });

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

  return { proc, stopTether: tether.stop };
}

export async function stopDaemon(handle: DaemonHandle | Bun.Subprocess): Promise<void> {
  const proc = "proc" in handle ? handle.proc : handle;

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

export function stopTetherMock(handle: DaemonHandle): void {
  handle.stopTether();
}

async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  opts: { timeoutMs: number; intervalMs: number; timeoutMessage: string },
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    const result = await check();
    if (result !== undefined) return result;
    await Bun.sleep(opts.intervalMs);
  }
  throw new Error(opts.timeoutMessage);
}

export function waitForNodeIdFile(stateDir: string, timeoutMs: number): Promise<string> {
  return pollUntil(async () => {
    const file = Bun.file(`${stateDir}/node_id`);
    if (await file.exists()) return (await file.text()).trim();
    return undefined;
  }, { timeoutMs, intervalMs: 100, timeoutMessage: "Timed out waiting for node_id file" });
}

export async function waitForNodeAvailability(nodeId: string, available: boolean, timeoutMs = 10_000): Promise<void> {
  await pollUntil(async () => {
    const [node] = await getDB().select().from(aiNodeT).where(sql`${aiNodeT.id} = ${nodeId}`).limit(1);
    return node?.available === available ? true : undefined;
  }, { timeoutMs, intervalMs: 200, timeoutMessage: `Timed out waiting for node ${nodeId} available=${available}` });
}

export async function waitForInstallationState(installationId: string, timeoutMs = 15_000): Promise<void> {
  await pollUntil(async () => {
    const [state] = await getDB()
      .select()
      .from(modelInstallationStateT)
      .where(sql`${modelInstallationStateT.id} = ${installationId}`)
      .limit(1);
    return state?.lifecycleState === "ready" ? true : undefined;
  }, { timeoutMs, intervalMs: 250, timeoutMessage: `Timed out waiting for installation state for ${installationId}` });
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
