import { describe, test, expect } from "bun:test";
import { freshPage, ownerPage, type TestPage } from "../utils/browser";
import { expectURL, expectVisible, expectHidden } from "../utils/helpers";
import { OWNER, STORAGE_STATE } from "../utils/test-data";

describe("Authentication flows", () => {
  test("unauthenticated visit to / redirects to /login/", async () => {
    const { page, context } = await freshPage();
    try {
      await page.goto("/");
      await expectURL(page, /\/login\/\?callbackUrl=/);
    } finally {
      await context.close();
    }
  });

  test("login page renders sign-in form by default", async () => {
    const { page, context } = await freshPage();
    try {
      await page.goto("/login/");
      await expectVisible(page.locator("#form-signin"));
      await expectHidden(page.locator("#form-signup"));
      await expectVisible(page.locator("#in-email"));
      await expectVisible(page.locator("#in-pass"));
    } finally {
      await context.close();
    }
  });

  test("invalid credentials show error message", async () => {
    const { page, context } = await freshPage();
    try {
      await page.goto("/login/");
      await page.waitForLoadState("networkidle");
      await page.locator("#in-email").fill("nonexistent@example.com");
      await page.locator("#in-pass").fill("WrongPassword123!");
      await page.locator("#form-signin button[type='submit']").click();

      await expectVisible(page.locator("p.text-red-600"));
    } finally {
      await context.close();
    }
  });

  test("valid credentials redirect to home", async () => {
    const { page, context } = await freshPage();
    try {
      await page.goto("/login/");
      await page.waitForLoadState("networkidle");
      await page.locator("#in-email").fill(OWNER.email);
      await page.locator("#in-pass").fill(OWNER.password);
      await page.locator("#form-signin button[type='submit']").click();

      await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
        timeout: 30_000,
      });
      expect(new URL(page.url()).pathname).toBe("/");
    } finally {
      await context.close();
    }
  });

  test("sign-up tab switches to registration form", async () => {
    const { page, context } = await freshPage();
    try {
      await page.goto("/login/");
      await page.waitForLoadState("networkidle");
      await page.locator("#tab-signup").click();

      await expectVisible(page.locator("#form-signup"));
      await expectVisible(page.locator("#name"));
      await expectVisible(page.locator("#up-email"));
      await expectVisible(page.locator("#up-pass"));
    } finally {
      await context.close();
    }
  });

  test("logout redirects to /login", async () => {
    const { page, context } = await freshPage();
    try {
      // Sign in first
      await page.goto("/login/");
      await page.waitForLoadState("networkidle");
      await page.locator("#in-email").fill(OWNER.email);
      await page.locator("#in-pass").fill(OWNER.password);
      await page.locator("#form-signin button[type='submit']").click();
      await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
        timeout: 30_000,
      });

      // Click logout, wait for page to fully load first
      await page.waitForLoadState("networkidle");
      await page.locator("nav button[aria-label='Logout']").click();
      await expectURL(page, /\/login/, 30_000);
    } finally {
      await context.close();
    }
  });

  test("authenticated visit to /login/ redirects to /", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/login/");
      await expectURL(page, /^[^?]*\/$/); // matches "/" without query params
    } finally {
      await context.close();
    }
  });
});
