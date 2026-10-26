import { randomBytes, randomUUID } from "node:crypto";
import { aiApiKeyT, aiApplicationT, apiCallT, aiNodeT, apiResponseT, inferenceCallT, modelDeploymentT, modelInstallationStateT, modelInstallationT, organizationT, preconfigureDB, sql } from "common-db";
import { METRICS_AUTH, getAvailablePort, readProcessOutput, waitForHttp } from "../test-helpers";
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

// Hard deletes, children first. A soft-deleted deployment or application still holds its organization,
// which then cannot be deleted, and every later run would start with one more organization.
export async function cleanupTestData(): Promise<void> {
  const database = getDB();
  const createdRows: Array<[any, string[]]> = [
    [modelInstallationT, createdInstallationIds],
    [aiNodeT, createdNodeIds],
    [modelDeploymentT, createdDeploymentIds],
    [aiApiKeyT, createdApiKeyIds],
    [aiApplicationT, createdAppIds],
    [organizationT, createdOrgIds],
  ];
  // A call's reference to its message bodies has no cascade, so the calls go before the organization.
  for (const id of createdOrgIds) {
    await database.delete(inferenceCallT).where(sql`${inferenceCallT.organizationId} = ${id}`);
    await database.delete(apiResponseT).where(sql`${apiResponseT.organizationId} = ${id}`);
  }
  for (const [table, ids] of createdRows) {
    for (const id of ids) {
      await database.delete(table).where(sql`${table.id} = ${id}`);
    }
    ids.length = 0;
  }
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
  // If we have a cached promise, check the process is actually still alive.
  // Bun's test runner kills dangling child processes between test files,
  // so we must be prepared to restart.
  if (gatewayReady && gatewayProcess) {
    const alive = !gatewayProcess.killed && gatewayProcess.exitCode === null;
    if (alive) {
      return gatewayReady;
    }
    // Process was killed externally, reset and restart.
    gatewayProcess = null;
    gatewayReady = null;
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
        METRICS_AUTH,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const healthUrl = `http://${HOST}:${PORT}/health`;
    const healthWait = waitForHttp(healthUrl, { timeoutMs: 20_000 });
    const exitWait = gatewayProcess.exited.then(async (code) => {
      const output = await readProcessOutput(gatewayProcess!);
      throw new Error(
        `Gateway exited before health check (code ${code}). stdout: ${output.stdout?.slice(-500) || "<empty>"} stderr: ${output.stderr || "<empty>"}`
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
  const timedOut = await Promise.race([
    exited.then(() => false),
    Bun.sleep(2000).then(() => true),
  ]);
  if (timedOut) {
    gatewayProcess.kill("SIGKILL");
    await exited;
  }
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

// The api_call row cascades away with its organization in cleanupTestData.
export async function createLegacyApiCall(orgId: string): Promise<void> {
  await getDB().insert(apiCallT).values({
    organizationId: orgId,
    model: "legacy-model",
    specifiedModel: "legacy-model",
    duration: 1,
    inputMessages: [],
    outputMessage: { role: "assistant", content: "" },
  });
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
  specifier?: string;
  deletedAt?: Date;
}): Promise<{ id: string; publicSpecifier: string }> {
  const publicSpecifier = input.publicSpecifier ?? `model-${randomUUID()}`;
  const specifier = input.specifier ?? publicSpecifier;
  const [deployment] = await getDB().insert(modelDeploymentT).values({
    organizationId: input.orgId,
    name: input.name ?? "Gateway Test Model",
    publicSpecifier,
    specifier,
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
  deploymentId: string;
  specifier: string;
  port: number;
  estCapacity?: number;
  driver?: "ollama" | "vllm";
  deletedAt?: Date;
  lifecycleState?: "downloading" | "installing" | "ready" | "failed";
}): Promise<{ id: string }> {
  const [installation] = await getDB().insert(modelInstallationT).values({
    nodeId: input.nodeId,
    deploymentId: input.deploymentId,
    specifier: input.specifier,
    estCapacity: input.estCapacity ?? 1,
    port: input.port,
    driver: input.driver ?? "ollama",
    deletedAt: input.deletedAt,
  }).returning();

  if (input.lifecycleState) {
    await getDB().insert(modelInstallationStateT).values({
      id: installation!.id,
      lifecycleState: input.lifecycleState,
    });
  }

  createdInstallationIds.push(installation!.id);
  return { id: installation!.id };
}

export async function createReadyInstallationFor(deployment: { id: string; publicSpecifier: string }): Promise<{ id: string }> {
  const node = await createAiNode();
  return createModelInstallation({
    deploymentId: deployment.id,
    nodeId: node.id,
    specifier: deployment.publicSpecifier,
    port: await getAvailablePort(),
    lifecycleState: "ready",
  });
}

export function makeUnknownKey(): string {
  return `sk_${randomBytes(16).toString("base64url")}${randomBytes(16).toString("base64url")}`;
}

/**
 * Starts a mock server that acts as a daemon proxy, handling
 * `/proxy/{model}/v1/...` paths and returning the given response body.
 * The returned port should be used as the aiNodeT port.
 */
async function startMockProxyServer(defaultBody: Record<string, unknown>, responseBody?: Record<string, unknown>): Promise<{
  port: number;
  stop: () => void;
}> {
  const port = await getAvailablePort();
  const body = responseBody ?? defaultBody;
  const server = Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/proxy/")) {
        return Response.json(body);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { port, stop: () => server.stop() };
}

export async function startMockChatCompletionServer(responseBody?: Record<string, unknown>) {
  return startMockProxyServer({
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
  return startMockProxyServer({
    object: "list",
    data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
    model: "internal-test-embedding-model",
    usage: { prompt_tokens: 3, total_tokens: 3 },
  }, responseBody);
}
