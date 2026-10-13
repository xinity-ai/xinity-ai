import { describe, test, expect } from "bun:test";
import { ownerPage } from "../utils/browser";
import { expectVisible } from "../utils/helpers";
import { TEST_ORG } from "../utils/test-data";

describe("Organization management", () => {
  test("organizations page loads and shows test org", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/organizations/");
      await page.waitForLoadState("networkidle");

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
      await page.waitForLoadState("networkidle");

      await expectVisible(page.getByText("Active"));
    } finally {
      await context.close();
    }
  });

  test("Create Organization links to the create page, since test mode unlocks multi-org", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto("/organizations/");
      await page.waitForLoadState("networkidle");

      const createLink = page.getByRole("link", { name: /Create Organization/ });
      await expectVisible(createLink);
      expect(await createLink.getAttribute("href")).toBe("/organizations/create/");
    } finally {
      await context.close();
    }
  });

  test("org detail page loads with org name", async () => {
    const { page, context } = await ownerPage();
    try {
      await page.goto(`/organizations/${TEST_ORG.slug}`);
      await page.waitForLoadState("networkidle");

      await expectVisible(page.getByText(TEST_ORG.name));
    } finally {
      await context.close();
    }
  });
});
