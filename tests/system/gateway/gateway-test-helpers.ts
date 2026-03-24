import { randomBytes, randomUUID } from "crypto";
import { createServer } from "net";
import { aiApiKeyT, aiApplicationT, aiNodeT, modelDeploymentT, modelInstallationT, organizationT, preconfigureDB, sql } from "common-db";
import { readProcessOutput, waitForHttp } from "../test-helpers";
import { ensureInfoServerRunning, infoServerUrl } from "../infoserver/infoserver-test-helpers";
import { ensureSystemReady } from "../guard";

const HOST = process.env.GATEWAY_HOST ?? "127.0.0.1";
let PORT = process.env.GATEWAY_PORT ?? "";

let db: ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;

// ─── Test data tracking for cleanup ──────────────────────────────────────────

const createdOrgIds: string[] = [];
const createdAppIds: string[] = [];
const createdApiKeyIds: string[] = [];
const createdDeploymentIds: string[] = [];
const createdNodeIds: string[] = [];
const createdInstallationIds: string[] = [];

/**
 * Soft-deletes (or hard-deletes where no deletedAt exists) all test data
 * created via the helper functions. Safe to call even if some deletes fail.
 */
export async function cleanupTestData(): Promise<void> {
  const database = getDB();
  const now = new Date();

  // Reverse order of dependencies: installations → nodes → deployments → keys → apps → orgs
  for (const id of createdInstallationIds) {
    try { await database.update(modelInstallationT).set({ deletedAt: now }).where(sql`${modelInstallationT.id} = ${id}`); } catch {}
  }
  for (const id of createdNodeIds) {
    try { await database.update(aiNodeT).set({ deletedAt: now }).where(sql`${aiNodeT.id} = ${id}`); } catch {}
  }
  for (const id of createdDeploymentIds) {
    try { await database.update(modelDeploymentT).set({ deletedAt: now }).where(sql`${modelDeploymentT.id} = ${id}`); } catch {}
  }
  for (const id of createdApiKeyIds) {
    try { await database.update(aiApiKeyT).set({ deletedAt: now }).where(sql`${aiApiKeyT.id} = ${id}`); } catch {}
  }
  for (const id of createdAppIds) {
    try { await database.update(aiApplicationT).set({ deletedAt: now }).where(sql`${aiApplicationT.id} = ${id}`); } catch {}
  }
  for (const id of createdOrgIds) {
    try { await database.delete(organizationT).where(sql`${organizationT.id} = ${id}`); } catch {}
  }

  // Clear arrays
  createdInstallationIds.length = 0;
  createdNodeIds.length = 0;
  createdDeploymentIds.length = 0;
  createdApiKeyIds.length = 0;
  createdAppIds.length = 0;
  createdOrgIds.length = 0;
}

function getDB() {
  if (!db) {
    const { getDB: init } = preconfigureDB(process.env.DB_CONNECTION_URL!);
    db = init();
  }
  return db;
}

let gatewayProcess: Bun.Subprocess | null = null;
let gatewayReady: Promise<void> | null = null;

export async function ensureGatewayRunning(): Promise<void> {
  if (gatewayReady) {
    return gatewayReady;
  }

  gatewayReady = (async () => {
    await ensureSystemReady();
    await ensureInfoServerRunning();

    if (!PORT) PORT = String(await getAvailablePort());

    const DB_CONNECTION_URL = process.env.DB_CONNECTION_URL!;
    const REDIS_URL = process.env.REDIS_URL!;

    gatewayProcess = Bun.spawn([
      "bun",
      "run",
      "src/gatewayServer.ts",
    ], {
      cwd: "packages/xinity-ai-gateway",
      env: {
        ...process.env,
        HOST,
        PORT,
        DB_CONNECTION_URL,
        REDIS_URL,
        INFOSERVER_URL: infoServerUrl(""),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const healthUrl = `http://${HOST}:${PORT}/healthCheck`;
    const healthWait = waitForHttp(healthUrl, { timeoutMs: 20_000 });
    const exitWait = gatewayProcess.exited.then(async (code) => {
      const output = await readProcessOutput(gatewayProcess!);
      throw new Error(
        `Gateway exited before health check (code ${code}). stderr: ${output.stderr || "<empty>"}`
      );
    });
    await Promise.race([healthWait, exitWait]);
  })();

  return gatewayReady;
}

export async function stopGateway(): Promise<void> {
  if (!gatewayProcess) {
    return;
  }
  const exited = gatewayProcess.exited;
  gatewayProcess.kill();
  const timeout = Bun.sleep(2000)
  await Promise.race([exited.then(() => undefined), timeout]);
  gatewayProcess = null;
  gatewayReady = null;
}

export function gatewayUrl(path: string): string {
  return `http://${HOST}:${PORT}${path}`;
}

export async function createOrganizationAndApp(): Promise<{ orgId: string; appId: string }> {
  const orgId = `org-${randomUUID()}`;
  await getDB().insert(organizationT).values({
    id: orgId,
    name: "Gateway System Tests",
    slug: `gateway-tests-${randomUUID()}`,
  });

  const [app] = await getDB().insert(aiApplicationT).values({
    name: "Gateway Test App",
    description: "System test app",
    organizationId: orgId,
  }).returning();

  createdOrgIds.push(orgId);
  createdAppIds.push(app!.id);
  return { orgId, appId: app!.id };
}

export async function createApiKey(input: {
  orgId: string;
  appId: string;
  enabled?: boolean;
  deletedAt?: Date;
}): Promise<{ fullKey: string; keyId: string }> {
  const specifier = `sk_${randomBytes(16).toString("base64url")}`;
  const secret = randomBytes(32).toString("base64url");
  const fullKey = `${specifier}${secret}`;
  const hash = await Bun.password.hash(fullKey);

  const [record] = await getDB().insert(aiApiKeyT).values({
    name: "Gateway Test Key",
    enabled: input.enabled ?? true,
    applicationId: input.appId,
    organizationId: input.orgId,
    specifier,
    hash,
    deletedAt: input.deletedAt,
  }).returning();

  createdApiKeyIds.push(record!.id);
  return { fullKey, keyId: record!.id };
}

export async function createModelDeployment(input: {
  orgId: string;
  name?: string;
  publicSpecifier?: string;
  modelSpecifier?: string;
  deletedAt?: Date;
}): Promise<{ id: string; publicSpecifier: string }> {
  const publicSpecifier = input.publicSpecifier ?? `model-${randomUUID()}`;
  const modelSpecifier = input.modelSpecifier ?? publicSpecifier;
  const [deployment] = await getDB().insert(modelDeploymentT).values({
    organizationId: input.orgId,
    name: input.name ?? "Gateway Test Model",
    publicSpecifier,
    modelSpecifier,
    deletedAt: input.deletedAt,
  }).returning();

  createdDeploymentIds.push(deployment!.id);
  return { id: deployment!.id, publicSpecifier: deployment!.publicSpecifier };
}

export async function createAiNode(input: { host?: string; port?: number; estCapacity?: number; deletedAt?: Date } = {}): Promise<{ id: string }> {
  const host = input.host ?? "127.0.0.1";
  const port = input.port ?? await getAvailablePort();
  const estCapacity = input.estCapacity ?? 64;
  const [node] = await getDB().insert(aiNodeT).values({
    host,
    port,
    estCapacity,
    deletedAt: input.deletedAt,
  }).onConflictDoUpdate({
    target: [aiNodeT.host, aiNodeT.port],
    targetWhere: sql`${aiNodeT.deletedAt} IS NULL`,
    set: { estCapacity, deletedAt: input.deletedAt },
  }).returning();

  createdNodeIds.push(node!.id);
  return { id: node!.id };
}

export async function createModelInstallation(input: {
  nodeId: string;
  model: string;
  port: number;
  estCapacity?: number;
  driver?: string;
  deletedAt?: Date;
}): Promise<{ id: string }> {
  const [installation] = await getDB().insert(modelInstallationT).values({
    nodeId: input.nodeId,
    model: input.model,
    estCapacity: input.estCapacity ?? 1,
    port: input.port,
    driver: input.driver ?? "ollama",
    deletedAt: input.deletedAt,
  }).returning();

  createdInstallationIds.push(installation!.id);
  return { id: installation!.id };
}

export function makeUnknownKey(): string {
  return `sk_${randomBytes(16).toString("base64url")}${randomBytes(16).toString("base64url")}`;
}

async function getAvailablePort(): Promise<number> {
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

async function startMockJsonServer(defaultBody: Record<string, unknown>, responseBody?: Record<string, unknown>): Promise<{
  port: number;
  stop: () => void;
}> {
  const port = await getAvailablePort();
  const body = responseBody ?? defaultBody;
  const server = Bun.serve({
    port,
    fetch: async () => Response.json(body),
  });
  return { port, stop: () => server.stop() };
}

export async function startMockChatCompletionServer(responseBody?: Record<string, unknown>) {
  return startMockJsonServer({
    id: `chatcmpl_${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "internal-test-model",
    choices: [
      { index: 0, message: { role: "assistant", content: "hello from mock" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  }, responseBody);
}

export async function startMockEmbeddingServer(responseBody?: Record<string, unknown>) {
  return startMockJsonServer({
    object: "list",
    data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
    model: "internal-test-embedding-model",
    usage: { prompt_tokens: 3, total_tokens: 3 },
  }, responseBody);
}
