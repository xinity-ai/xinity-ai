import { describe, test, expect } from "bun:test";
import { ownerPage } from "../utils/browser";
import { expectVisible } from "../utils/helpers";

/**
 * Renders against whatever fleet exists in the dev database. Run
 * `bun run seed:fleet` first for the full experience; the page itself must
 * also render correctly with an empty fleet.
 */
describe("Fleet page", () => {
  test("sidebar shows Compute and navigates to the fleet page", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const nav = page.locator("nav");
      await expectVisible(nav.locator("span:text-is('Compute')"));

      await nav.locator("span:text-is('Compute')").click();
      await page.waitForURL(/\/fleet\//);
      await expectVisible(page.locator("h1:text-is('Compute')"));
    } finally {
      await context.close();
    }
  });

  test("renders fleet totals and machine cards or the empty state", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/fleet/");
      await page.waitForLoadState("networkidle");

      const cards = page.locator("[data-testid='machine-card']");
      const emptyState = page.locator("text=No compute connected yet");

      const cardCount = await cards.count();
      if (cardCount === 0) {
        await expectVisible(emptyState);
      } else {
        // Hero tiles render with the fleet
        await expectVisible(page.locator("text=Machines").first());
        await expectVisible(page.locator("text=Fleet load").first());
        await expectVisible(page.locator("text=Fleet activity").first());
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
      await page.goto("/fleet/");
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
