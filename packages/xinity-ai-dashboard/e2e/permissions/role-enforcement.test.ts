import { describe, test, expect } from "bun:test";
import { ownerPage, viewerPage } from "../utils/browser";
import { expectVisible } from "../utils/helpers";
import { TEST_ORG } from "../utils/test-data";

describe("Permission enforcement", () => {
  test("owner sees API key management controls", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/ai-api-keys/");
      await page.waitForLoadState("domcontentloaded");

      await expectVisible(page.getByRole("button", { name: /Generate New Key/ }));
    } finally {
      await context.close();
    }
  });

  test("viewer cannot see API key create/delete controls", async () => {
    const { page, context } = await viewerPage();
    try {
      await page.goto("/ai-api-keys/");
      await page.waitForLoadState("domcontentloaded");

      expect(
        await page.getByRole("button", { name: /Generate New Key/ }).isVisible(),
      ).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("owner sees invite controls on org detail page", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto(`/organizations/${TEST_ORG.slug}`);
      await page.waitForLoadState("domcontentloaded");

      // If the org isn't the active one, activate it first
      const activateBtn = page.getByRole("button", { name: "Activate", exact: true });
      if (await activateBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await activateBtn.click();
        await page.waitForLoadState("domcontentloaded");
      }

      await expectVisible(page.getByRole("button", { name: /Invite/ }));
      await expectVisible(page.getByText("Danger Zone"));
    } finally {
      await context.close();
    }
  });

  test("viewer has limited controls on org detail page", async () => {
    const { page, context } = await viewerPage();
    try {
      await page.goto(`/organizations/${TEST_ORG.slug}`);
      await page.waitForLoadState("domcontentloaded");

      expect(
        await page.getByRole("button", { name: /Invite/ }).isVisible(),
      ).toBe(false);
      expect(await page.getByText("Danger Zone").isVisible()).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("owner sees deployment creation on Model Hub", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/modelhub/");
      await page.waitForLoadState("domcontentloaded");

      // Owner should see either "Deploy Your First Model" or "Deploy New Model"
      const hasButton = await page
        .getByRole("button", { name: /Deploy.*Model/ })
        .isVisible({ timeout: 5_000 })
        .catch(() => false);
      const hasCard = await page
        .getByText("Deploy New Model")
        .isVisible({ timeout: 2_000 })
        .catch(() => false);

      expect(hasButton || hasCard).toBe(true);
    } finally {
      await context.close();
    }
  });
});
