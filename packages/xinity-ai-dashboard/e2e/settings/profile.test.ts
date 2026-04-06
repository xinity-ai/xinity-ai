import { describe, test, expect } from "bun:test";
import { ownerPage } from "../utils/browser";
import { expectVisible, expectURL, expectValue } from "../utils/helpers";
import { OWNER } from "../utils/test-data";

describe("Settings & profile", () => {
  test("settings page loads with navigation items", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/settings/");
      // Settings root redirects to /settings/profile
      await expectURL(page, /\/settings\/profile/);

      await expectVisible(page.getByRole("heading", { name: "Settings", exact: true }));
      await expectVisible(page.getByRole("link", { name: "Profile" }));
      await expectVisible(page.getByRole("link", { name: "Notifications" }));
      await expectVisible(page.getByRole("link", { name: "Display" }));
      await expectVisible(page.getByRole("link", { name: "Authentication" }));
    } finally {
      await context.close();
    }
  });

  test("can navigate between settings sub-pages", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/settings/profile");
      await page.waitForLoadState("networkidle");

      await page.getByRole("link", { name: "Notifications" }).click();
      await expectURL(page, /\/settings\/notifications/);

      await page.getByRole("link", { name: "Display" }).click();
      await expectURL(page, /\/settings\/display/);

      await page.getByRole("link", { name: "Authentication" }).click();
      await expectURL(page, /\/settings\/auth/);

      await page.getByRole("link", { name: "Profile" }).click();
      await expectURL(page, /\/settings\/profile/);
    } finally {
      await context.close();
    }
  });

  test("profile page shows user name and email", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/settings/profile");
      await page.waitForLoadState("networkidle");

      await expectVisible(page.getByRole("heading", { name: "Profile Settings" }));
      await expectValue(page.locator("#name"), OWNER.name);
      await expectValue(page.locator("#email"), OWNER.email);

      expect(await page.locator("#email").isDisabled()).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("can update profile name", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/settings/profile");
      await page.waitForLoadState("networkidle");

      const newName = `E2E Owner ${Date.now()}`;
      await page.locator("#name").fill(newName);
      await page.getByRole("button", { name: /Save Settings/ }).click();

      await page.getByText("Settings saved successfully").waitFor({ state: "visible", timeout: 30_000 });

      // Restore original name
      await page.locator("#name").fill(OWNER.name);
      await page.getByRole("button", { name: /Save Settings/ }).click();
      await page.getByText("Settings saved successfully").waitFor({ state: "visible", timeout: 30_000 });
    } finally {
      await context.close();
    }
  });
});
