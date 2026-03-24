import { describe, test, expect } from "bun:test";
import { ownerPage } from "../utils/browser";
import { expectVisible } from "../utils/helpers";

describe("API key CRUD", () => {
  test("API keys page loads with heading", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/ai-api-keys/");
      await page.waitForLoadState("domcontentloaded");

      await expectVisible(page.getByRole("heading", { name: "API Integration" }));
      await expectVisible(page.getByText("API Keys", { exact: true }));
    } finally {
      await context.close();
    }
  });

  test("can open create key modal", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/ai-api-keys/");
      await page.waitForLoadState("domcontentloaded");

      await page.getByRole("button", { name: /Generate New Key/ }).click();
      await expectVisible(page.locator("#keyName"));
    } finally {
      await context.close();
    }
  });

  test("can create an API key", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/ai-api-keys/");
      await page.waitForLoadState("domcontentloaded");

      await page.getByRole("button", { name: /Generate New Key/ }).click();
      await expectVisible(page.locator("#keyName"));

      const keyName = `e2e-key-${Date.now()}`;
      await page.locator("#keyName").fill(keyName);

      // Select "Create new application" if app select is visible
      const appSelect = page.locator("#appSelect");
      if (await appSelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await appSelect.selectOption("__new__");
        const appDesc = page.locator("#appDesc");
        if (await appDesc.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await appDesc.fill("E2E test application");
        }
      }

      await page.getByRole("button", { name: "Create", exact: true }).click();

      // Should show the full key
      await expectVisible(page.locator("#fullKey"), 10_000);

      // Close modal and verify key appears in listing
      await page.keyboard.press("Escape");
      await expectVisible(page.getByTitle(keyName));
    } finally {
      await context.close();
    }
  });

  test("can toggle key enabled/disabled", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/ai-api-keys/");
      await page.waitForLoadState("domcontentloaded");

      const deactivateBtn = page.getByRole("button", { name: "Deactivate" }).first();
      if (await deactivateBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await deactivateBtn.click();

        // Should now show Activate
        await page.getByRole("button", { name: "Activate" }).first().waitFor({ state: "visible", timeout: 5_000 });

        // Toggle back
        await page.getByRole("button", { name: "Activate" }).first().click();
        await deactivateBtn.waitFor({ state: "visible", timeout: 5_000 });
      }
    } finally {
      await context.close();
    }
  });

  test("can delete a key", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/ai-api-keys/");
      await page.waitForLoadState("domcontentloaded");

      const deleteBtn = page.getByRole("button", { name: "Delete" }).first();
      if (await deleteBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await deleteBtn.click();

        // Confirmation modal
        const confirmDelete = page.getByRole("dialog").getByRole("button", { name: "Delete" });
        await confirmDelete.waitFor({ state: "visible", timeout: 15_000 });
        await confirmDelete.click();

        // Toast confirmation
        await page.getByRole("alert").getByText(/Deleted API key/).waitFor({ state: "visible", timeout: 15_000 });
      }
    } finally {
      await context.close();
    }
  });
});
