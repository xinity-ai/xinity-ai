/**
 * API-based setup: creates test users via /api/onboarding/cli,
 * signs them in to get session cookies, saves Playwright storage state files.
 *
 * Can be run standalone (`bun run e2e/global-setup.ts`) or imported.
 */
import {
  OWNER,
  VIEWER,
  TEST_ORG,
  STORAGE_STATE,
  API_KEY_STATE,
  BASE_URL,
} from "./utils/test-data";
import { mkdirSync } from "fs";
import { dirname } from "path";

// ─── Types ──────────────────────────────────────────────────────────

interface OnboardResult {
  dashboardApiKey: string;
  userId: string;
  orgId: string;
  orgSlug: string;
}

interface SessionResponse {
  user?: { id: string };
}

interface OrgResponse {
  id: string;
  name: string;
  slug: string;
}

interface InvitationResponse {
  id: string;
  organizationId: string;
  email: string;
  status: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function apiUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

/** Common headers needed for Better Auth endpoints (CSRF protection requires Origin). */
const AUTH_HEADERS = {
  "Content-Type": "application/json",
  Origin: BASE_URL,
} as const;

/** Extract set-cookie headers and convert to Playwright cookie format. */
function parseCookies(response: Response): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
}> {
  const url = new URL(BASE_URL);
  const cookies: ReturnType<typeof parseCookies> = [];

  for (const header of response.headers.getSetCookie()) {
    const parts = header.split(";").map((s) => s.trim());
    const [nameValue] = parts;
    if (!nameValue) continue;

    const eqIdx = nameValue.indexOf("=");
    if (eqIdx === -1) continue;

    const name = nameValue.slice(0, eqIdx);
    const value = nameValue.slice(eqIdx + 1);

    let path = "/";
    let httpOnly = false;
    let secure = false;
    let sameSite: "Lax" | "Strict" | "None" = "Lax";

    for (const part of parts.slice(1)) {
      const lower = part.toLowerCase();
      if (lower.startsWith("path=")) path = part.slice(5);
      else if (lower === "httponly") httpOnly = true;
      else if (lower === "secure") secure = true;
      else if (lower.startsWith("samesite=")) {
        const val = part.slice(9);
        if (val === "Strict") sameSite = "Strict";
        else if (val === "None") sameSite = "None";
      }
    }

    cookies.push({
      name,
      value,
      domain: url.hostname,
      path,
      httpOnly,
      secure,
      sameSite,
    });
  }

  return cookies;
}

/** Create a user + org via the CLI onboarding endpoint. Returns the dashboard API key. */
async function onboardUser(user: { name: string; email: string; password: string }, orgName: string): Promise<OnboardResult> {
  const res = await fetch(apiUrl("/api/onboarding/cli"), {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      name: user.name,
      email: user.email,
      password: user.password,
      orgName,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // CONFLICT means user/org already exists, recover by signing in
    if (res.status === 409) {
      console.log(`  User ${user.email} or org "${orgName}" already exists, recovering...`);
      return recoverExistingUser(user, orgName);
    }
    throw new Error(`Onboarding failed for ${user.email}: ${res.status} ${body}`);
  }

  return (await res.json()) as OnboardResult;
}

/** When a user already exists, sign in and find their org. */
async function recoverExistingUser(
  user: { email: string; password: string },
  orgName: string,
): Promise<OnboardResult> {
  // Sign in to get session
  const signInRes = await signIn(user);
  const cookies = cookieString(parseCookies(signInRes));

  // Get session to find userId
  const sessionRes = await fetch(apiUrl("/api/auth/get-session"), {
    headers: { Cookie: cookies, Origin: BASE_URL },
  });
  const session = (await sessionRes.json()) as SessionResponse;
  const userId = session?.user?.id ?? "";

  // List organizations to find the one matching orgName
  const orgsRes = await fetch(apiUrl("/api/auth/organization/list"), {
    headers: { Cookie: cookies, Origin: BASE_URL },
  });
  const orgs = (await orgsRes.json()) as OrgResponse[];
  const org = orgs?.find((o) => o.name === orgName);

  if (!org) {
    console.log(`  Could not find org "${orgName}" for ${user.email}. Available: ${orgs?.map(o => o.name).join(", ") ?? "none"}`);
    return { dashboardApiKey: "", userId, orgId: "", orgSlug: "" };
  }

  // Dashboard API keys can only be created server-side, so leave it empty.
  // API tests will use session cookies instead.
  return { dashboardApiKey: "", userId, orgId: org.id, orgSlug: org.slug };
}

/** Sign in via Better Auth and return the response with session cookies. */
async function signIn(user: { email: string; password: string }): Promise<Response> {
  const res = await fetch(apiUrl("/api/auth/sign-in/email"), {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({ email: user.email, password: user.password }),
    redirect: "manual",
  });

  if (!res.ok && res.status !== 302) {
    const body = await res.text();
    throw new Error(`Sign-in failed for ${user.email}: ${res.status} ${body}`);
  }

  return res;
}

/** Set the active organization for the current session. Returns updated cookie string. */
async function setActiveOrg(orgId: string, cookies: string): Promise<string> {
  const res = await fetch(apiUrl("/api/auth/organization/set-active"), {
    method: "POST",
    headers: { ...AUTH_HEADERS, Cookie: cookies },
    body: JSON.stringify({ organizationId: orgId }),
    redirect: "manual",
  });

  // Merge any new cookies from the response
  const newSetCookies = res.headers.getSetCookie();
  if (newSetCookies.length === 0) return cookies;

  const merged = new Map<string, string>();
  for (const c of cookies.split("; ")) {
    const eqIdx = c.indexOf("=");
    if (eqIdx !== -1) merged.set(c.slice(0, eqIdx), c.slice(eqIdx + 1));
  }
  for (const header of newSetCookies) {
    const kv = header.split(";")[0] ?? "";
    const eqIdx = kv.indexOf("=");
    if (eqIdx !== -1) merged.set(kv.slice(0, eqIdx), kv.slice(eqIdx + 1));
  }
  return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Write Playwright-compatible storage state file. */
async function writeStorageState(
  path: string,
  cookies: ReturnType<typeof parseCookies>,
): Promise<void> {
  const state = {
    cookies,
    origins: [],
  };
  await Bun.write(path, JSON.stringify(state, null, 2));
}

/** Get cookie string from parsed cookies for use in subsequent requests. */
function cookieString(cookies: ReturnType<typeof parseCookies>): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Convert a cookie string back to Playwright cookie format (minimal). */
function parseCookiesFromString(cookieStr: string): ReturnType<typeof parseCookies> {
  const url = new URL(BASE_URL);
  return cookieStr.split("; ").map((c) => {
    const eqIdx = c.indexOf("=");
    return {
      name: c.slice(0, eqIdx),
      value: c.slice(eqIdx + 1),
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax" as const,
    };
  });
}

/** Invite a user to an organization via Better Auth. */
async function inviteMember(
  email: string,
  role: string,
  orgId: string,
  cookies: string,
): Promise<void> {
  const res = await fetch(apiUrl("/api/auth/organization/invite-member"), {
    method: "POST",
    headers: { ...AUTH_HEADERS, Cookie: cookies },
    body: JSON.stringify({ email, role, organizationId: orgId }),
    redirect: "manual",
  });

  if (!res.ok && res.status !== 302) {
    const body = await res.text();
    // Ignore if already a member or already invited
    if (body.includes("already") || res.status === 409) {
      console.log(`  ${email}: ${body}`);
      return;
    }
    throw new Error(`Invite failed for ${email}: ${res.status} ${body}`);
  }
}

/** Accept an invitation for a user. */
async function acceptInvitation(
  invitationId: string,
  cookies: string,
): Promise<void> {
  const res = await fetch(apiUrl("/api/auth/organization/accept-invitation"), {
    method: "POST",
    headers: { ...AUTH_HEADERS, Cookie: cookies },
    body: JSON.stringify({ invitationId }),
    redirect: "manual",
  });

  if (!res.ok && res.status !== 302) {
    const body = await res.text();
    console.log(`  Accept invitation response: ${res.status} ${body}`);
  }
}

/** Get pending invitations for an org (from the owner's perspective). */
async function getOrgInvitations(cookies: string): Promise<InvitationResponse[]> {
  const res = await fetch(apiUrl("/api/auth/organization/get-full-organization"), {
    method: "GET",
    headers: { Cookie: cookies, Origin: BASE_URL },
  });

  if (!res.ok) return [];
  const data = (await res.json()) as { invitations?: InvitationResponse[] };
  return Array.isArray(data?.invitations) ? data.invitations : [];
}

// ─── Main ───────────────────────────────────────────────────────────

export async function runSetup(): Promise<{ ownerApiKey: string; orgId: string }> {
  mkdirSync(dirname(STORAGE_STATE.owner), { recursive: true });

  // ── 1. Create owner user + org via CLI onboarding ─────────────
  console.log("  Creating owner via /api/onboarding/cli...");
  const ownerResult = await onboardUser(OWNER, TEST_ORG.name);

  if (!ownerResult.orgId) {
    throw new Error("Setup failed: could not determine orgId for owner. Delete .auth/ and DB test data, then retry.");
  }

  // ── 2. Sign in as owner, set active org, save storage state ───
  console.log("  Signing in as owner...");
  const ownerSignInRes = await signIn(OWNER);
  let ownerCookieStr = cookieString(parseCookies(ownerSignInRes));
  ownerCookieStr = await setActiveOrg(ownerResult.orgId, ownerCookieStr);
  await writeStorageState(STORAGE_STATE.owner, parseCookiesFromString(ownerCookieStr));

  // ── 3. Create viewer user ─────────────────────────────────────
  console.log("  Creating viewer user...");
  await onboardUser(VIEWER, `${TEST_ORG.name} Viewer Temp`);

  // ── 4. Invite viewer to owner's org ───────────────────────────
  console.log("  Inviting viewer to org...");
  await inviteMember(VIEWER.email, "viewer", ownerResult.orgId, ownerCookieStr);

  // ── 5. Accept invitation as viewer ────────────────────────────
  console.log("  Accepting invitation as viewer...");
  const viewerSignInRes = await signIn(VIEWER);
  let viewerCookieStr = cookieString(parseCookies(viewerSignInRes));

  // Check if viewer is already a member of the owner's org
  const viewerOrgsRes = await fetch(apiUrl("/api/auth/organization/list"), {
    headers: { Cookie: viewerCookieStr, Origin: BASE_URL },
  });
  const viewerOrgs = (viewerOrgsRes.ok ? await viewerOrgsRes.json() : []) as OrgResponse[];
  const alreadyMember = viewerOrgs.some((o) => o.id === ownerResult.orgId);

  if (!alreadyMember) {
    // Get pending invitation from owner's org data
    const invitations = await getOrgInvitations(ownerCookieStr);
    const pending = invitations.find(
      (inv) => inv.email === VIEWER.email && inv.status === "pending",
    );
    if (pending) {
      await acceptInvitation(pending.id, viewerCookieStr);
    } else {
      console.log("  No pending invitation found. Sending a new invite...");
      await inviteMember(VIEWER.email, "viewer", ownerResult.orgId, ownerCookieStr);
      // Re-fetch invitations to get the new one
      const newInvitations = await getOrgInvitations(ownerCookieStr);
      const newPending = newInvitations.find(
        (inv) => inv.email === VIEWER.email && inv.status === "pending",
      );
      if (newPending) {
        await acceptInvitation(newPending.id, viewerCookieStr);
      }
    }
  } else {
    console.log("  Viewer is already a member of the org.");
  }

  // ── 6. Set active org for viewer and save state ───────────────
  viewerCookieStr = await setActiveOrg(ownerResult.orgId, viewerCookieStr);
  await writeStorageState(STORAGE_STATE.viewer, parseCookiesFromString(viewerCookieStr));

  // ── 7. Persist state for API tests ────────────────────────────
  const apiKeyState = {
    ownerApiKey: ownerResult.dashboardApiKey,
    orgId: ownerResult.orgId,
    orgSlug: ownerResult.orgSlug,
  };
  await Bun.write(API_KEY_STATE, JSON.stringify(apiKeyState, null, 2));

  console.log("  Setup complete.");
  return { ownerApiKey: ownerResult.dashboardApiKey, orgId: ownerResult.orgId };
}

// Auto-run when executed directly
if (import.meta.main) {
  runSetup().catch((err) => {
    console.error("Setup failed:", err);
    process.exit(1);
  });
}
