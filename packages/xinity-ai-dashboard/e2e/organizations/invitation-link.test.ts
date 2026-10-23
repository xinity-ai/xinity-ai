import { describe, test, expect } from "bun:test";
import type { Page } from "playwright-core";
import { freshPage } from "../utils/browser";
import { expectURL, expectVisible } from "../utils/helpers";
import { TEST_ORG } from "../utils/test-data";
import { ensureSignedUp, findMailLink } from "../utils/sign-up";
import { getSetupState, ownerFetch } from "../api/api-helpers";

const PASSWORD = "TestPassword123!";

function uniqueEmail(label: string): string {
  return `e2e-invite-${label}-${Date.now()}@xinity-test.local`;
}

async function inviteAndReadLink(email: string): Promise<string> {
  const { orgId } = await getSetupState();
  const res = await ownerFetch("/api/auth/organization/invite-member", {
    method: "POST",
    body: JSON.stringify({ email, role: "member", organizationId: orgId }),
  });
  expect(res.ok).toBe(true);
  const link = await findMailLink(email, "accept-invitation-");
  if (!link) {
    throw new Error(`No invitation email reached ${email}`);
  }
  return link;
}

async function memberEmails(): Promise<string[]> {
  const res = await ownerFetch("/api/auth/organization/get-full-organization");
  const org = (await res.json()) as { members: Array<{ user: { email: string } }> };
  return org.members.map((member) => member.user.email);
}

async function removeMember(email: string): Promise<void> {
  const { orgId } = await getSetupState();
  await ownerFetch("/api/auth/organization/remove-member", {
    method: "POST",
    body: JSON.stringify({ memberIdOrEmail: email, organizationId: orgId }),
  });
}

async function acceptAndExpectLandedInTestOrg(page: Page): Promise<void> {
  const accept = page.getByRole("button", { name: "Accept invitation" });
  await expectVisible(accept);
  await accept.click();
  await page.waitForURL((url) => url.pathname === `/organizations/${TEST_ORG.slug}/`, { timeout: 30_000 });
}

describe("Invitation link", () => {
  test("a new invitee signs up, verifies the email and joins the organization", async () => {
    const email = uniqueEmail("new");
    const link = await inviteAndReadLink(email);
    const { page, context } = await freshPage();
    try {
      await page.goto(link);
      await expectURL(page, /\/login\/\?callbackUrl=/);
      await page.waitForLoadState("networkidle");
      await expectVisible(page.locator("#form-signup"));
      expect(await page.locator("#up-email").inputValue()).toBe(email);

      await page.locator("#name").fill("E2E Invitee");
      await page.locator("#up-pass").fill(PASSWORD);
      await page.locator("#form-signup button[type='submit']").click();
      await expectVisible(page.getByText("Check your email"));

      const verificationLink = await findMailLink(email, "verify-email");
      if (!verificationLink) {
        throw new Error(`No verification email reached ${email}`);
      }
      await page.goto(verificationLink);

      await acceptAndExpectLandedInTestOrg(page);
      expect(await memberEmails()).toContain(email);
    } finally {
      await context.close();
      await removeMember(email);
    }
  });

  test("an existing user signs in from the invitation link and joins the organization", async () => {
    const email = uniqueEmail("existing");
    await ensureSignedUp({ name: "E2E Existing Invitee", email, password: PASSWORD });
    const link = await inviteAndReadLink(email);
    const { page, context } = await freshPage();
    try {
      await page.goto(link);
      await expectURL(page, /\/login\/\?callbackUrl=/);
      await page.waitForLoadState("networkidle");

      await page.locator("#tab-signin").click();
      await page.locator("#in-email").fill(email);
      await page.locator("#in-pass").fill(PASSWORD);
      await page.locator("#form-signin button[type='submit']").click();

      await acceptAndExpectLandedInTestOrg(page);
      expect(await memberEmails()).toContain(email);
    } finally {
      await context.close();
      await removeMember(email);
    }
  });
});
