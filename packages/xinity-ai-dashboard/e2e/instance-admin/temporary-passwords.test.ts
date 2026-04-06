import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "path";
import { type TestPage } from "../utils/browser";
import { expectVisible, expectURL } from "../utils/helpers";
import { ensureE2EReady } from "../guard";
import { ownerFetch } from "../api/api-helpers";
import { BASE_URL } from "../utils/test-data";

const AUTH_HEADERS = {
  "Content-Type": "application/json",
  Origin: BASE_URL,
} as const;

const suffix = Date.now();
const TEST_USER = {
  name: `Temp PW E2E ${suffix}`,
  email: `e2e-temppw-${suffix}@xinity-test.local`,
};
const STORAGE_PATH = join(import.meta.dirname, "..", ".auth", `temppw-${suffix}.json`);
const PERMANENT_PASSWORD = "PermanentPassword789!";

let createdUserId = "";
let tempPassword = "";
let postResetTempPassword = "";
let postResetStoragePath = "";

interface CreateUserResponse {
  success: boolean;
  userId: string;
  temporaryPassword: string;
}

interface ResetPasswordResponse {
  success: boolean;
  temporaryPassword: string;
}

/** Sign in via API and save a Playwright-compatible storage state file. */
async function signInAndSaveState(email: string, password: string, storagePath: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  if (!res.ok && res.status !== 302) {
    throw new Error(`Sign-in failed: ${res.status} ${await res.text()}`);
  }
  const baseUrl = new URL(BASE_URL);
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
      domain: baseUrl.hostname,
      path: "/",
      httpOnly: parts.some((p) => p.toLowerCase() === "httponly"),
      secure: false,
      sameSite: "Lax" as const,
    });
  }
  await Bun.write(storagePath, JSON.stringify({ cookies, origins: [] }, null, 2));
}

/** Create a browser page authenticated using the given storage state file. */
async function pageWithState(storagePath: string): Promise<TestPage> {
  const { getBrowser } = await import("../utils/browser");
  const browser = await getBrowser();
  const context = await browser.newContext({ baseURL: BASE_URL, storageState: storagePath });
  const page = await context.newPage();
  return { context, page };
}

describe("Temporary password flow", () => {
  beforeAll(async () => {
    await ensureE2EReady();

    // Owner creates a new user via the instance-admin API
    const res = await ownerFetch("/api/instance-admin/users/create", {
      method: "POST",
      body: JSON.stringify({ name: TEST_USER.name, email: TEST_USER.email }),
    });
    if (!res.ok) {
      throw new Error(`createUser failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as CreateUserResponse;
    createdUserId = data.userId;
    tempPassword = data.temporaryPassword;

    // Sign in as the created user so browser tests can use their session
    await signInAndSaveState(TEST_USER.email, tempPassword, STORAGE_PATH);
  });

  test("createUser returns a userId and a 16-char temporaryPassword", () => {
    expect(createdUserId).toBeTruthy();
    expect(tempPassword).toHaveLength(16);
  });

  test("user with temporary password is redirected to /settings/auth", async () => {
    const { page, context } = await pageWithState(STORAGE_PATH);
    try {
      await page.goto("/");
      await expectURL(page, /\/settings\/auth/, 15_000);
    } finally {
      await context.close();
    }
  });

  test("/settings/auth is accessible and shows the temporary password warning", async () => {
    const { page, context } = await pageWithState(STORAGE_PATH);
    try {
      await page.goto("/settings/auth");
      await page.waitForLoadState("networkidle");
      await expectVisible(page.getByRole("heading", { name: "Authentication Settings" }));
      await expectVisible(page.getByText("Temporary password", { exact: true }));
    } finally {
      await context.close();
    }
  });

  test("changing password clears the temporary password flag and stops the redirect", async () => {
    const { page, context } = await pageWithState(STORAGE_PATH);
    try {
      await page.goto("/settings/auth");
      await page.locator("#current-password").waitFor({ state: "visible", timeout: 10_000 });
      await page.locator("#current-password").fill(tempPassword);
      await page.locator("#new-password").fill(PERMANENT_PASSWORD);
      await page.locator("#confirm-password").fill(PERMANENT_PASSWORD);
      await page.getByRole("button", { name: /Change Password/ }).click();

      await page.getByRole("alert").getByText("Password changed successfully").waitFor({
        state: "visible",
        timeout: 30_000,
      });

      // Navigating away should no longer redirect to /settings/auth
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).pathname).not.toBe("/settings/auth");
    } finally {
      await context.close();
    }
  });

  test("resetUserPassword returns a new temporaryPassword", async () => {
    const res = await ownerFetch("/api/instance-admin/users/reset-password", {
      method: "POST",
      body: JSON.stringify({ userId: createdUserId }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as ResetPasswordResponse;
    expect(data.success).toBe(true);
    expect(data.temporaryPassword).toHaveLength(16);

    postResetTempPassword = data.temporaryPassword;
    postResetStoragePath = join(import.meta.dirname, "..", ".auth", `temppw-reset-${suffix}.json`);
    await signInAndSaveState(TEST_USER.email, postResetTempPassword, postResetStoragePath);
  });

  test("user is redirected to /settings/auth after an admin password reset", async () => {
    const { page, context } = await pageWithState(postResetStoragePath);
    try {
      await page.goto("/");
      await expectURL(page, /\/settings\/auth/, 15_000);
    } finally {
      await context.close();
    }
  });
});
