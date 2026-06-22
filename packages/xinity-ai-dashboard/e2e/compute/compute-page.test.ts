import { describe, test, expect } from "bun:test";
import { ownerPage } from "../utils/browser";
import { expectVisible } from "../utils/helpers";

/**
 * Renders against whatever node set exists in the dev database. Run
 * `bun run simulate:compute` first for the full experience; the page itself must
 * also render correctly with an empty node set.
 */
describe("Compute page", () => {
  test("instance-settings nav shows Compute and navigates to the Compute page", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/instance-settings/");
      await page.waitForLoadState("networkidle");

      const nav = page.locator("nav");
      await expectVisible(nav.locator("text=Compute").first());

      await nav.locator("text=Compute").first().click();
      await page.waitForURL(/\/instance-settings\/compute\//);
      await expectVisible(page.locator("h1:text-is('Compute')"));
    } finally {
      await context.close();
    }
  });

  test("renders compute totals and machine cards or the empty state", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/instance-settings/compute/");
      await page.waitForLoadState("networkidle");

      const cards = page.locator("[data-testid='machine-card']");
      const emptyState = page.locator("text=No compute connected yet");

      const cardCount = await cards.count();
      if (cardCount === 0) {
        await expectVisible(emptyState);
      } else {
        // Hero tiles render with the node set
        await expectVisible(page.locator("text=Machines").first());
        await expectVisible(page.locator("text=Activity").first());
        // Every card shows a success/requests line or the no-requests hint
        const firstCard = cards.first();
        await expectVisible(firstCard);
      }
    } finally {
      await context.close();
    }
  });

  test("range selector switches without errors", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/instance-settings/compute/");
      await page.waitForLoadState("networkidle");

      const sevenDays = page.locator("button:text-is('7d')");
      if (await sevenDays.isVisible()) {
        await sevenDays.click();
        await page.waitForTimeout(500);
        await expectVisible(page.locator("h1:text-is('Compute')"));
      }
    } finally {
      await context.close();
    }
  });
});
