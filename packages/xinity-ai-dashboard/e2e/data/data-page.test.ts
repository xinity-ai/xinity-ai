import { describe, test, expect } from "bun:test";
import { ownerFetch, getSetupState } from "../api/api-helpers";
import { chatMessageT, inferenceCallMessageT, inferenceCallT, preconfigureDB } from "common-db";
import { jsonDigest } from "common-env";
import { ownerPage } from "../utils/browser";
import { expectVisible } from "../utils/helpers";

type CreatedKey = {
  fullKey: string;
  name: string;
  specifier: string;
  applicationId: string | null;
}

type ListedKey = {
  id: string;
  specifier: string;
  applicationId: string | null;
}

const SEEDED_CALLS = 7;

/**
 * The gateway is not running in the e2e stack, so the log is written directly. Messages are
 * content-addressed and referenced rather than inline, which is the shape the Data view reads.
 */
async function seedInferenceCalls(orgId: string, apiKeyId: string, applicationId: string) {
  const dbUrl = process.env.DB_CONNECTION_URL;
  if (!dbUrl) {
    throw new Error("DB_CONNECTION_URL not set; copy example.env to .env at the repo root");
  }
  const db = preconfigureDB(dbUrl).getDB();

  for (let i = 0; i < SEEDED_CALLS; i++) {
    // Bodies are content-addressed and unique per organization, so a rerun must not repeat them.
    const bodies = [
      { role: "user", content: `data-page seed prompt ${i} for ${applicationId}` },
      { role: "assistant", content: `data-page seed reply ${i} for ${applicationId}` },
    ];

    const [call] = await db
      .insert(inferenceCallT)
      .values({
        organizationId: orgId,
        apiKeyId,
        applicationId,
        endpoint: "chat_completions",
        servedModel: "seed-engine-model",
        publicSpecifier: "seed-model",
        durationMs: 100 + i,
      })
      .returning({ id: inferenceCallT.id });

    const messages = await db
      .insert(chatMessageT)
      .values(bodies.map((body) => ({ organizationId: orgId, sha256: jsonDigest(body), body })))
      .returning({ id: chatMessageT.id, sha256: chatMessageT.sha256 });

    await db.insert(inferenceCallMessageT).values(bodies.map((body, seq) => ({
      callId: call!.id,
      seq,
      messageId: messages.find((row) => row.sha256 === jsonDigest(body))!.id,
      direction: seq === 0 ? "input" as const : "output" as const,
    })));
  }
}

describe("Data page", () => {
  test("renders seeded api calls without svelte async-required errors", async () => {
    const suffix = Date.now();

    const createRes = await ownerFetch("/api/api-key/", {
      method: "POST",
      body: JSON.stringify({
        name: `data-page-regression-${suffix}`,
        enabled: true,
        createApplication: {
          name: `Data Page Regression ${suffix}`,
          description: "Created by data-page regression test",
        },
      }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as CreatedKey;
    const applicationId = created.applicationId;
    if (!applicationId) throw new Error("createApiKey did not return applicationId");

    const listRes = await ownerFetch("/api/api-key/", { method: "GET" });
    expect(listRes.status).toBe(200);
    const keys = (await listRes.json()) as ListedKey[];
    const keyRow = keys.find((k) => k.specifier === created.specifier);
    if (!keyRow) throw new Error(`could not find created key with specifier ${created.specifier}`);
    const apiKeyId = keyRow.id;

    const { orgId } = await getSetupState();
    await seedInferenceCalls(orgId, apiKeyId, applicationId);

    const { page, context } = await ownerPage();
    try {
      const pageErrors: Error[] = [];
      page.on("pageerror", (err) => pageErrors.push(err));

      await page.goto(`/data/${applicationId}/`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });

      await expectVisible(page.getByText("Recent API Calls"), 60_000);
      await expectVisible(page.locator('[role="listitem"]').first(), 60_000);
      await expectVisible(page.getByText(new RegExp(`Showing ${SEEDED_CALLS} of ${SEEDED_CALLS} calls`)), 60_000);

      const asyncErr = pageErrors.find((e) =>
        /experimental_async_required/.test(e.message),
      );
      if (asyncErr) {
        throw new Error(
          `Data page threw experimental_async_required. This usually means SvelteKit's remote query() is reaching svelte.hydratable() without compilerOptions.experimental.async being set in svelte.config.js. Original error: ${asyncErr.message}`,
        );
      }
    } finally {
      await context.close();
    }
  });
});
