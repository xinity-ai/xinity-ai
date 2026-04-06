import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "path";
import { freshPage, type TestPage } from "../utils/browser";
import { expectVisible, expectURL } from "../utils/helpers";
import { ensureE2EReady } from "../guard";
import { ownerFetch, apiUrl } from "../api/api-helpers";
import { BASE_URL, MAILHOG_API } from "../utils/test-data";

const AUTH_HEADERS = {
  "Content-Type": "application/json",
  Origin: BASE_URL,
} as const;

// Dedicated test user, unique per run to avoid collisions
const suffix = Date.now();
const TEST_USER = {
  name: "PW Change E2E",
  email: `e2e-pwchange-${suffix}@xinity-test.local`,
  password: "OldPassword123!",
};
const NEW_PASSWORD = "NewPassword456!";

const STORAGE_PATH = join(import.meta.dirname, "..", ".auth", `pwchange-${suffix}.json`);

/** Decode quoted-printable encoding and HTML entities. */
function decodeQP(raw: string): string {
  return raw
    .replace(/=\r?\n/g, "")       // join soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, "&");
}

interface MailhogResponse {
  items?: Array<{ Content?: { Body?: string } }>;
}

/** Poll Mailhog for a verification URL sent to the given email. */
async function getVerificationUrl(email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(
      `${MAILHOG_API}/v2/search?kind=to&query=${encodeURIComponent(email)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as MailhogResponse;
      for (const item of data?.items ?? []) {
        const decoded = decodeQP(item?.Content?.Body ?? "");
        const match = decoded.match(/https?:\/\/[^\s"<>]+verify-email[^\s"<>]*/);
        if (match) return match[0];
      }
    }
    await Bun.sleep(500);
  }
  throw new Error(`No verification email found for ${email}`);
}

/** Sign in via API and save Playwright-compatible storage state file. */
async function signInAndSaveState(email: string, password: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });

  if (!res.ok && res.status !== 302) {
    throw new Error(`Sign-in failed: ${res.status} ${await res.text()}`);
  }

  const url = new URL(BASE_URL);
  const cookies = [];
  for (const header of res.headers.getSetCookie()) {
    const parts = header.split(";").map((s) => s.trim());
    const [nameValue] = parts;
    if (!nameValue) continue;
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx === -1) continue;

    cookies.push({
      name: nameValue.slice(0, eqIdx),
      value: nameValue.slice(eqIdx + 1),
      domain: url.hostname,
      path: "/",
      httpOnly: parts.some((p) => p.toLowerCase() === "httponly"),
      secure: false,
      sameSite: "Lax" as const,
    });
  }

  await Bun.write(STORAGE_PATH, JSON.stringify({ cookies, origins: [] }, null, 2));
}

/** Create a browser page authenticated as the test user. */
async function testUserPage(): Promise<TestPage> {
  const { getBrowser } = await import("../utils/browser");
  const browser = await getBrowser();
  const context = await browser.newContext({
    baseURL: BASE_URL,
    storageState: STORAGE_PATH,
  });
  const page = await context.newPage();
  return { context, page };
}

describe("Password change via UI", () => {
  beforeAll(async () => {
    await ensureE2EReady();

    // 1. Invite test user from owner so sign-up works in invite-only mode
    await ownerFetch("/api/auth/organization/invite-member", {
      method: "POST",
      body: JSON.stringify({ email: TEST_USER.email, role: "member" }),
    });

    // 2. Sign up via Better Auth
    const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        name: TEST_USER.name,
        email: TEST_USER.email,
        password: TEST_USER.password,
      }),
    });
    if (!signUpRes.ok) {
      throw new Error(`Sign-up failed: ${signUpRes.status} ${await signUpRes.text()}`);
    }

    // 3. Verify email via Mailhog
    const verifyUrl = await getVerificationUrl(TEST_USER.email);
    await fetch(verifyUrl, { redirect: "manual" });

    // 4. Sign in and save storage state for browser tests
    await signInAndSaveState(TEST_USER.email, TEST_USER.password);
  });

  test("auth settings page shows password section", async () => {
    const { page, context } = await testUserPage();
    try {
      await page.goto("/settings/auth");
      await page.waitForLoadState("networkidle");

      await expectVisible(page.getByRole("heading", { name: "Authentication Settings" }));
      // Password section is open by default
      await expectVisible(page.locator("#current-password"));
    } finally {
      await context.close();
    }
  });

  test("change password through the UI form", async () => {
    const { page, context } = await testUserPage();
    try {
      await page.goto("/settings/auth");
      await page.waitForLoadState("networkidle");

      // Ensure the password form is visible (collapsible open by default)
      await page.locator("#current-password").waitFor({ state: "visible", timeout: 10_000 });

      // Fill the password change form
      await page.locator("#current-password").fill(TEST_USER.password);
      await page.locator("#new-password").fill(NEW_PASSWORD);
      await page.locator("#confirm-password").fill(NEW_PASSWORD);
      await page.getByRole("button", { name: /Change Password/ }).click();

      // Wait for success toast
      await page.getByRole("alert").getByText("Password changed successfully").waitFor({
        state: "visible",
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });

  test("login with old password fails", async () => {
    const { page, context } = await freshPage();
    try {
      await page.goto("/login/");
      await page.waitForLoadState("networkidle");

      await page.locator("#in-email").fill(TEST_USER.email);
      await page.locator("#in-pass").fill(TEST_USER.password);
      await page.locator("#form-signin button[type='submit']").click();

      // Should show an error, not redirect
      await expectVisible(page.locator("p.text-red-600"));
    } finally {
      await context.close();
    }
  });

  test("login with new password succeeds", async () => {
    const { page, context } = await freshPage();
    try {
      await page.goto("/login/");
      await page.waitForLoadState("networkidle");

      await page.locator("#in-email").fill(TEST_USER.email);
      await page.locator("#in-pass").fill(NEW_PASSWORD);
      await page.locator("#form-signin button[type='submit']").click();

      // Successful login redirects away from /login
      await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });
});
