import { describe, test, expect } from "bun:test";
import { ownerPage } from "../utils/browser";
import { expectVisible } from "../utils/helpers";
import { TEST_ORG } from "../utils/test-data";

describe("Organization management", () => {
  test("organizations page loads and shows test org", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/organizations/");
      await page.waitForLoadState("domcontentloaded");

      await expectVisible(page.getByRole("heading", { name: "Organizations" }));
      await expectVisible(page.getByText(TEST_ORG.name));
    } finally {
      await context.close();
    }
  });

  test("active org displays Active badge", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/organizations/");
      await page.waitForLoadState("domcontentloaded");

      await expectVisible(page.getByText("Active"));
    } finally {
      await context.close();
    }
  });

  test("Create Organization button is disabled without multi-org license", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/organizations/");
      await page.waitForLoadState("domcontentloaded");

      const createButton = page.locator('button[disabled]', { hasText: /Create Organization/ }).first();
      await expectVisible(createButton);
      expect(await createButton.isDisabled()).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("org detail page loads with org name", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto(`/organizations/${TEST_ORG.slug}`);
      await page.waitForLoadState("domcontentloaded");

      await expectVisible(page.getByText(TEST_ORG.name));
    } finally {
      await context.close();
    }
  });
});
