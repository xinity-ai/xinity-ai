/**
 * System test: multimodal image storage via SeaweedFS S3.
 *
 * Requires SeaweedFS running on S3_ENDPOINT (default http://127.0.0.1:8333).
 * Start the full dev stack including SeaweedFS:
 *   docker compose -f docker/dev.compose.yaml up -d dev
 *
 * Then run:
 *   bun test --timeout 30000 tests/system/gateway/gateway.multimodal-s3.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { apiCallT, mediaObjectT, preconfigureDB, sql } from "common-db";
import { readProcessOutput, waitForHttp } from "../test-helpers";
import { ensureSystemReady } from "../guard";
import { ensureInfoServerRunning, infoServerUrl } from "../infoserver/infoserver-test-helpers";
import {
  cleanupTestData,
  createApiKey,
  createAiNode,
  createModelDeployment,
  createModelInstallation,
  createOrganizationAndApp,
  startMockChatCompletionServer,
} from "./gateway-test-helpers";

// ─── Configuration ────────────────────────────────────────────────────────────

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:8333";
const S3_BUCKET = process.env.S3_BUCKET ?? "xinity-media-test";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY_ID ?? "testkey";
const S3_SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY ?? "testsecret";
const S3_REGION = process.env.S3_REGION ?? "us-east-1";

const GATEWAY_HOST = "127.0.0.1";
const GATEWAY_PORT = "41215"; // distinct port from main gateway system tests

// ─── Tiny 1×1 red PNG (base64) ───────────────────────────────────────────────

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URI = `data:image/png;base64,${TINY_PNG_BASE64}`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

let db: ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;
let gatewayProcess: Bun.Subprocess | null = null;

function getDB() {
  if (!db) {
    const { getDB: init } = preconfigureDB(process.env.DB_CONNECTION_URL!);
    db = init();
  }
  return db;
}

function gatewayUrl(path: string): string {
  return `http://${GATEWAY_HOST}:${GATEWAY_PORT}${path}`;
}

/** Check whether SeaweedFS S3 is reachable on the configured endpoint. */
async function isSeaweedFSReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${S3_ENDPOINT}/`, { signal: AbortSignal.timeout(3_000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Create the test bucket in SeaweedFS via unsigned S3 PUT. */
async function ensureBucket(bucket: string): Promise<void> {
  const res = await fetch(`${S3_ENDPOINT}/${bucket}`, { method: "PUT" });
  // 200 = created, 409 = already exists, both are fine
  if (!res.ok && res.status !== 409) {
    throw new Error(`Failed to create test bucket '${bucket}': HTTP ${res.status}`);
  }
}

/** Check whether an S3 object exists in SeaweedFS. */
async function objectExists(bucket: string, key: string): Promise<boolean> {
  const res = await fetch(`${S3_ENDPOINT}/${bucket}/${key}`, { method: "HEAD" });
  return res.status === 200;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensureSystemReady();

  // Skip entire suite if SeaweedFS is not available
  if (!(await isSeaweedFSReachable())) {
    console.warn(
      `\nSkipping multimodal S3 system tests, SeaweedFS not reachable at ${S3_ENDPOINT}\n` +
        `  Start it with: docker compose -f docker/dev.compose.yaml up -d seaweedfs\n`,
    );
    return;
  }

  await ensureBucket(S3_BUCKET);
  await ensureInfoServerRunning();

  // Spawn a gateway instance with S3 configured
  gatewayProcess = Bun.spawn(["bun", "run", "src/gatewayServer.ts"], {
    cwd: "packages/xinity-ai-gateway",
    env: {
      ...process.env,
      HOST: GATEWAY_HOST,
      PORT: GATEWAY_PORT,
      DB_CONNECTION_URL: process.env.DB_CONNECTION_URL!,
      REDIS_URL: process.env.REDIS_URL!,
      INFOSERVER_URL: infoServerUrl(""),
      S3_ENDPOINT,
      S3_ACCESS_KEY_ID: S3_ACCESS_KEY,
      S3_SECRET_ACCESS_KEY: S3_SECRET_KEY,
      S3_BUCKET,
      S3_REGION,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const healthUrl = gatewayUrl("/healthCheck");
  const exitWait = gatewayProcess.exited.then(async (code) => {
    const output = await readProcessOutput(gatewayProcess!);
    throw new Error(
      `Gateway (S3) exited before health check (code ${code}). stderr: ${output.stderr || "<empty>"}`,
    );
  });
  await Promise.race([waitForHttp(healthUrl, { timeoutMs: 20_000 }), exitWait]);
});

afterAll(async () => {
  try { await cleanupTestData(); } catch {}
  if (gatewayProcess) {
    const exited = gatewayProcess.exited;
    gatewayProcess.kill();
    await Promise.race([exited.then(() => undefined), Bun.sleep(2_000)]);
    gatewayProcess = null;
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("multimodal image storage (SeaweedFS S3)", () => {
  it("skips if SeaweedFS is not available", async () => {
    // This test always passes; the skip logic is in beforeAll.
    // If beforeAll didn't throw, we're either skipping or ready.
    if (!(await isSeaweedFSReachable())) {
      console.log("SeaweedFS not available, test skipped");
      return;
    }
    expect(true).toBe(true);
  });

  it("uploads a data URI image to S3 and stores xinity-media:// ref in DB", async () => {
    if (!(await isSeaweedFSReachable())) return;

    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });
    const publicSpecifier = `model-s3-test-${randomUUID()}`;
    const internalModel = `internal-s3-${randomUUID()}`;

    await createModelDeployment({ orgId, publicSpecifier, modelSpecifier: internalModel });

    const mockServer = await startMockChatCompletionServer({
      id: "chatcmpl_s3test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: internalModel,
      choices: [{ index: 0, message: { role: "assistant", content: "got it" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const node = await createAiNode({ port: mockServer.port });
    await createModelInstallation({ nodeId: node.id, model: internalModel, port: mockServer.port });

    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: TINY_PNG_DATA_URI } },
        ],
      },
    ];

    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fullKey}`,
      },
      body: JSON.stringify({ model: publicSpecifier, messages }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.object).toBe("chat.completion");

    // ── Verify DB: apiCall logged with xinity-media:// reference ─────────────
    // Wait briefly for async log write
    await Bun.sleep(300);

    const calls = await getDB()
      .select()
      .from(apiCallT)
      .where(sql`${apiCallT.organizationId} = ${orgId}`);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const call = calls[calls.length - 1]!;
    const callMessages = call.inputMessages as any[];
    const userMsg = callMessages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();

    const imgPart = Array.isArray(userMsg.content)
      ? userMsg.content.find((p: any) => p.type === "image_url")
      : null;
    expect(imgPart).toBeDefined();
    expect(imgPart!.image_url.url).toMatch(/^xinity-media:\/\/[0-9a-f]{64}$/);

    const sha256 = imgPart!.image_url.url.replace("xinity-media://", "");

    // ── Verify DB: mediaObject row created ───────────────────────────────────
    const mediaObjects = await getDB()
      .select()
      .from(mediaObjectT)
      .where(sql`${mediaObjectT.organizationId} = ${orgId}`);

    expect(mediaObjects.length).toBe(1);
    const mediaObj = mediaObjects[0]!;
    expect(mediaObj.sha256).toBe(sha256);
    expect(mediaObj.mimeType).toBe("image/png");
    expect(mediaObj.originalUrl).toBeNull(); // was a data URI, no original URL
    expect(mediaObj.s3Bucket).toBe(S3_BUCKET);
    expect(mediaObj.size).toBeGreaterThan(0);

    // ── Verify S3: object exists in SeaweedFS ────────────────────────────────
    const s3Key = `${orgId}/${sha256}`;
    expect(await objectExists(S3_BUCKET, s3Key)).toBe(true);

    mockServer.stop();
  });

  it("deduplicates identical images (same sha256 → one mediaObject row)", async () => {
    if (!(await isSeaweedFSReachable())) return;

    const { orgId, appId } = await createOrganizationAndApp();
    const { fullKey } = await createApiKey({ orgId, appId });
    const publicSpecifier = `model-dedup-${randomUUID()}`;
    const internalModel = `internal-dedup-${randomUUID()}`;

    await createModelDeployment({ orgId, publicSpecifier, modelSpecifier: internalModel });

    const mockServer = await startMockChatCompletionServer();
    const node = await createAiNode({ port: mockServer.port });
    await createModelInstallation({ nodeId: node.id, model: internalModel, port: mockServer.port });

    // Send two requests with the same image
    const makeRequest = () =>
      fetch(gatewayUrl("/v1/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${fullKey}` },
        body: JSON.stringify({
          model: publicSpecifier,
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URI } }],
            },
          ],
        }),
      });

    const [res1, res2] = await Promise.all([makeRequest(), makeRequest()]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    await Bun.sleep(400);

    // Only one mediaObject row should exist for this org (dedup on sha256)
    const mediaObjects = await getDB()
      .select()
      .from(mediaObjectT)
      .where(sql`${mediaObjectT.organizationId} = ${orgId}`);

    expect(mediaObjects.length).toBe(1);

    mockServer.stop();
  });

  it("works when S3 is disabled, data URI stripped from DB, response still 200", async () => {
    // This test uses the *main* gateway-test-helpers gateway (no S3 env vars).
    // We spin up a second gateway without S3 here.
    const noS3Port = "41216";

    const noS3Gateway = Bun.spawn(["bun", "run", "src/gatewayServer.ts"], {
      cwd: "packages/xinity-ai-gateway",
      env: {
        ...process.env,
        HOST: GATEWAY_HOST,
        PORT: noS3Port,
        DB_CONNECTION_URL: process.env.DB_CONNECTION_URL!,
        REDIS_URL: process.env.REDIS_URL!,
        INFOSERVER_URL: infoServerUrl(""),
        // S3 vars intentionally omitted
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const noS3Url = (path: string) => `http://${GATEWAY_HOST}:${noS3Port}${path}`;

    try {
      const exitWait = noS3Gateway.exited.then(async (code) => {
        const out = await readProcessOutput(noS3Gateway);
        throw new Error(`Gateway (no-S3) exited (code ${code}): ${out.stderr}`);
      });
      await Promise.race([waitForHttp(noS3Url("/healthCheck"), { timeoutMs: 15_000 }), exitWait]);

      const { orgId, appId } = await createOrganizationAndApp();
      const { fullKey } = await createApiKey({ orgId, appId });
      const publicSpecifier = `model-nos3-${randomUUID()}`;
      const internalModel = `internal-nos3-${randomUUID()}`;

      await createModelDeployment({ orgId, publicSpecifier, modelSpecifier: internalModel });
      const mockServer = await startMockChatCompletionServer();
      const node = await createAiNode({ port: mockServer.port });
      await createModelInstallation({ nodeId: node.id, model: internalModel, port: mockServer.port });

      const res = await fetch(noS3Url("/v1/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${fullKey}` },
        body: JSON.stringify({
          model: publicSpecifier,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "hello" },
                { type: "image_url", image_url: { url: TINY_PNG_DATA_URI } },
              ],
            },
          ],
        }),
      });

      expect(res.status).toBe(200);

      await Bun.sleep(300);

      const calls = await getDB()
        .select()
        .from(apiCallT)
        .where(sql`${apiCallT.organizationId} = ${orgId}`);

      expect(calls.length).toBeGreaterThanOrEqual(1);
      const call = calls[calls.length - 1]!;
      const callMessages = call.inputMessages as any[];
      const userMsg = callMessages.find((m: any) => m.role === "user");
      expect(userMsg).toBeDefined();

      // The data URI image should be stripped; only text part remains
      const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
      const hasDataUri = parts.some(
        (p: any) => p.type === "image_url" && p.image_url?.url?.startsWith("data:"),
      );
      expect(hasDataUri).toBe(false);

      const textPart = parts.find((p: any) => p.type === "text");
      expect(textPart?.text).toBe("hello");

      mockServer.stop();
    } finally {
      const exited = noS3Gateway.exited;
      noS3Gateway.kill();
      await Promise.race([exited.then(() => undefined), Bun.sleep(2_000)]);
    }
  });
});
