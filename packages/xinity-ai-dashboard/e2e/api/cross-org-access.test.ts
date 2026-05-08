/**
 * Regression tests: an admin of one organization cannot mutate members of
 * another organization.
 *
 * Two distinct users each own their own organization. The "attacker" tries to
 * remove or re-role the "victim" by smuggling the victim's `organizationId`
 * and `memberId` into the request body. Both calls must fail and the victim's
 * org must be untouched.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { ensureE2EReady } from "../guard";
import { BASE_URL } from "../utils/test-data";

const ATTACKER = {
  name: "Cross-Org Attacker",
  email: "e2e-cross-org-attacker@xinity-test.local",
  password: "TestPassword123!",
  orgName: "Cross-Org Attacker Org",
} as const;

const VICTIM = {
  name: "Cross-Org Victim",
  email: "e2e-cross-org-victim@xinity-test.local",
  password: "TestPassword123!",
  orgName: "Cross-Org Victim Org",
} as const;

const AUTH_HEADERS = {
  "Content-Type": "application/json",
  Origin: BASE_URL,
} as const;

interface OrgRow { id: string; name: string; slug: string }
interface MemberRow { id: string; role: string; userId: string; user: { email: string } }
interface FullOrg { id: string; members: MemberRow[] }

let attackerCookies: string;
let victimOrgId: string;
let victimMemberId: string;
let originalVictimRole: string;

async function ensureUser(user: typeof ATTACKER): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/onboarding/cli`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      name: user.name,
      email: user.email,
      password: user.password,
      orgName: user.orgName,
    }),
  });
  // 409 means the user already exists from a previous run, which is fine
  if (!res.ok && res.status !== 409) {
    throw new Error(`Onboarding failed for ${user.email}: ${res.status} ${await res.text()}`);
  }
}

function extractCookies(res: Response): string {
  return res.headers.getSetCookie()
    .map((h) => h.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

function mergeCookies(prev: string, res: Response): string {
  const merged = new Map<string, string>();
  for (const c of prev.split("; ")) {
    const i = c.indexOf("=");
    if (i !== -1) merged.set(c.slice(0, i), c.slice(i + 1));
  }
  for (const h of res.headers.getSetCookie()) {
    const kv = h.split(";")[0] ?? "";
    const i = kv.indexOf("=");
    if (i !== -1) merged.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  if (!res.ok && res.status !== 302) {
    throw new Error(`Sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  }
  return extractCookies(res);
}

async function listOrgs(cookies: string): Promise<OrgRow[]> {
  const res = await fetch(`${BASE_URL}/api/auth/organization/list`, {
    headers: { Cookie: cookies, Origin: BASE_URL },
  });
  if (!res.ok) throw new Error(`listOrgs failed: ${res.status}`);
  return (await res.json()) as OrgRow[];
}

async function setActive(orgId: string, cookies: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/organization/set-active`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, Cookie: cookies },
    body: JSON.stringify({ organizationId: orgId }),
    redirect: "manual",
  });
  if (!res.ok && res.status !== 302) {
    throw new Error(`set-active failed: ${res.status} ${await res.text()}`);
  }
  return mergeCookies(cookies, res);
}

async function getFullOrg(cookies: string): Promise<FullOrg> {
  const res = await fetch(`${BASE_URL}/api/auth/organization/get-full-organization`, {
    headers: { Cookie: cookies, Origin: BASE_URL },
  });
  if (!res.ok) throw new Error(`getFullOrg failed: ${res.status}`);
  return (await res.json()) as FullOrg;
}

async function findVictimMember(): Promise<MemberRow | null> {
  let cookies = await signIn(VICTIM.email, VICTIM.password);
  cookies = await setActive(victimOrgId, cookies);
  const full = await getFullOrg(cookies);
  return full.members.find((m) => m.id === victimMemberId) ?? null;
}

async function attackerFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...AUTH_HEADERS,
      Cookie: attackerCookies,
      ...init?.headers,
    },
  });
}

beforeAll(async () => {
  await ensureE2EReady();

  await ensureUser(ATTACKER);
  await ensureUser(VICTIM);

  // Attacker: sign in and lock onto their own org so withOrganization is happy.
  let aCookies = await signIn(ATTACKER.email, ATTACKER.password);
  const aOrgs = await listOrgs(aCookies);
  const aOrg = aOrgs.find((o) => o.name === ATTACKER.orgName);
  if (!aOrg) throw new Error(`Attacker's org not found. Got: ${aOrgs.map((o) => o.name).join(", ")}`);
  aCookies = await setActive(aOrg.id, aCookies);
  attackerCookies = aCookies;

  // Victim: discover their org id and own memberId so the test has concrete targets.
  let vCookies = await signIn(VICTIM.email, VICTIM.password);
  const vOrgs = await listOrgs(vCookies);
  const vOrg = vOrgs.find((o) => o.name === VICTIM.orgName);
  if (!vOrg) throw new Error(`Victim's org not found. Got: ${vOrgs.map((o) => o.name).join(", ")}`);
  victimOrgId = vOrg.id;
  vCookies = await setActive(victimOrgId, vCookies);
  const full = await getFullOrg(vCookies);
  const me = full.members.find((m) => m.user.email === VICTIM.email);
  if (!me) throw new Error("Victim's own member row not found in their org");
  victimMemberId = me.id;
  originalVictimRole = me.role;
});

describe("Organization member mutation: cross-org access", () => {
  test("removeMember refuses to act on a member of a different org", async () => {
    const res = await attackerFetch("/api/organization/remove-member", {
      method: "POST",
      // organizationId is intentionally smuggled: the input schema must strip it
      // and the handler must use context.activeOrganizationId (attacker's own org).
      body: JSON.stringify({
        memberId: victimMemberId,
        organizationId: victimOrgId,
      }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const after = await findVictimMember();
    expect(after).not.toBeNull();
    expect(after!.id).toBe(victimMemberId);
  });

  test("updateMemberRole refuses to act on a member of a different org", async () => {
    const res = await attackerFetch("/api/organization/update-role", {
      method: "POST",
      body: JSON.stringify({
        memberId: victimMemberId,
        role: "viewer",
        organizationId: victimOrgId,
      }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const after = await findVictimMember();
    expect(after).not.toBeNull();
    expect(after!.role).toBe(originalVictimRole);
  });
});
