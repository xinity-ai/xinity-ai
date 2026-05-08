import { describe, test, expect } from "bun:test";
import { ownerFetch } from "../api/api-helpers";
import { ownerPage } from "../utils/browser";
import { expectVisible } from "../utils/helpers";

interface CreatedKey {
  fullKey: string;
  name: string;
  specifier: string;
  applicationId: string | null;
}

interface ListedKey {
  id: string;
  specifier: string;
  applicationId: string | null;
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

    const seedRes = await ownerFetch("/api/api-call/add-example-data", {
      method: "POST",
      body: JSON.stringify({ apiKeyId, applicationId }),
    });
    expect(seedRes.status).toBe(200);

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
      await expectVisible(page.getByText(/Showing 7 of 7 calls/), 60_000);

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
