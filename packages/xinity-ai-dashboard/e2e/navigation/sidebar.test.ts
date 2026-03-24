import { describe, test, expect } from "bun:test";
import { ownerPage, viewerPage } from "../utils/browser";
import { expectVisible, expectHidden } from "../utils/helpers";

describe("Sidebar navigation", () => {
  test("owner sees all sidebar items", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/");
      await page.waitForLoadState("domcontentloaded");

      const nav = page.locator("nav");
      await expectVisible(nav.locator("span:text-is('Home')"));
      await expectVisible(nav.locator("span:text-is('AI API Keys')"));
      await expectVisible(nav.locator("span:text-is('Data')"));
      await expectVisible(nav.locator("span:text-is('Training')"));
      await expectVisible(nav.locator("span:text-is('Model Hub')"));
      await expectVisible(nav.locator("span:text-is('Organizations')"));
      await expectVisible(nav.locator("span:text-is('Settings')"));
      await expectVisible(nav.locator("span:text-is('Logout')"));
    } finally {
      await context.close();
    }
  });

  test("viewer sidebar is missing AI API Keys", async () => {
    const { page, context } = await viewerPage();
    try {
      await page.goto("/");
      await page.waitForLoadState("domcontentloaded");

      const nav = page.locator("nav");

      // Viewer can see these
      await expectVisible(nav.locator("span:text-is('Home')"));
      await expectVisible(nav.locator("span:text-is('Data')"));
      await expectVisible(nav.locator("span:text-is('Training')"));
      await expectVisible(nav.locator("span:text-is('Model Hub')"));
      await expectVisible(nav.locator("span:text-is('Organizations')"));
      await expectVisible(nav.locator("span:text-is('Settings')"));
      await expectVisible(nav.locator("span:text-is('Logout')"));

      // Viewer should NOT see AI API Keys
      expect(await nav.locator("span:text-is('AI API Keys')").isVisible()).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("active link is highlighted", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/organizations/");
      await page.waitForLoadState("domcontentloaded");

      const orgLink = page.locator('nav a[href="/organizations/"]');
      const classes = await orgLink.getAttribute("class");
      expect(classes).toContain("!bg-gray-50");
    } finally {
      await context.close();
    }
  });

  test("sidebar links navigate correctly", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/");
      await page.waitForLoadState("domcontentloaded");

      await page.locator("nav span:text-is('Settings')").click();
      await page.waitForURL(/\/settings\//);

      await page.locator("nav span:text-is('Organizations')").click();
      await page.waitForURL(/\/organizations\//);
    } finally {
      await context.close();
    }
  });
});
