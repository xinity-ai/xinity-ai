import { auth } from "$lib/server/auth-server";
import { rootLogger } from "$lib/server/logging";
import { serverEnv, isInstanceAdmin } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import type { LayoutServerLoad } from "./$types";
import { redirect, type Cookies } from "@sveltejs/kit";
// path to root package version
import {version} from "../../../../../package.json";
import { semver } from "bun";
import { timeCache } from "$lib/util";
import type { RoleName } from "$lib/roles";
import { sql, and, eq, isNull, userT, aiNodeT, type DisplaySettings } from "common-db";
import { getLicenseSummary, hasFeature } from "$lib/server/license";

const log = rootLogger.child({name: "+layout.root"})

export const load: LayoutServerLoad = async ({ request, url, cookies }) => {
  const session = await auth.api.getSession(request);
  if (!session) redirectToLogin(url);

  if (!session.session.activeOrganizationId && !url.searchParams.has('_orgActivated')) {
    const activatedOrgId = await autoActivateFirstOrganization(request.headers);
    if (activatedOrgId) {
      clearBetterAuthSessionCacheCookies(cookies);
      const redirectUrl = new URL(url);
      redirectUrl.searchParams.set('_orgActivated', '1');
      redirect(302, redirectUrl.pathname + redirectUrl.search);
    }
  }

  const memberRole = await loadActiveMemberRole(session.session.activeOrganizationId, request.headers);

  const { displaySettings, temporaryPassword } = await fetchUserSettings(session.user.id);

  // Force users with temporary passwords to the password change page
  if (temporaryPassword && !url.pathname.startsWith("/settings/auth")) {
    redirect(302, "/settings/auth");
  }

  const totalVramGb = await fetchTotalAvailableVramGb();

  return {
    user: session.user,
    session: session.session,
    activeOrganizationId: session.session.activeOrganizationId,
    memberRole,
    displaySettings,
    temporaryPassword,
    isInstanceAdmin: isInstanceAdmin(session.user.email),
    singleTenantMode: !serverEnv.MULTI_TENANT_MODE,
    canCreateOrganization: (serverEnv.MULTI_TENANT_MODE || isInstanceAdmin(session.user.email)) && (hasFeature("multi-org") || !session.session.activeOrganizationId),
    versioning: interpretVersion(),
    license: getLicenseSummary(),
    totalVramGb,
  };
};

function fallbackToCurrentVersion(reason: string): string {
  log.warn(reason);
  return version;
}

const fetchVersion = timeCache(1000 * 60 * 5, async () => {
  const res = await fetch(new URL("/version.json", serverEnv.INFOSERVER_URL), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    return fallbackToCurrentVersion("Unable to reach infoserver to retrieve version");
  }
  const json = await res.json();
  if ("version" in json && typeof json.version === "string") {
    return json.version as string;
  }
  return fallbackToCurrentVersion("Unable to extract version from version request output.");
});

function redirectToLogin(currentUrl: URL): never {
  rootLogger.info({ name: "auth" }, "redirecting");
  const loginUrl = new URL("/login/", currentUrl.origin);
  loginUrl.searchParams.set("callbackUrl", currentUrl.toString());
  const email = currentUrl.searchParams.get("email");
  if (email) {
    loginUrl.searchParams.set("email", email);
    loginUrl.searchParams.set("tab", "signup");
  }
  redirect(302, loginUrl.pathname + loginUrl.search);
}

async function loadActiveMemberRole(activeOrgId: string | null | undefined, headers: Headers): Promise<RoleName | null> {
  if (!activeOrgId) return null;
  try {
    const activeMember = await auth.api.getActiveMember({ headers });
    const memberRole = activeMember?.role ? (activeMember.role as RoleName) : null;
    log.debug({ memberRole, activeMember }, "Active member role loaded");
    return memberRole;
  } catch (err) {
    log.warn({ err }, "Failed to get active member role");
    return null;
  }
}

async function autoActivateFirstOrganization(headers: Headers): Promise<string | null> {
  try {
    const organizations = await auth.api.listOrganizations({ headers });
    if (!organizations || organizations.length === 0) return null;
    const targetOrgId = organizations[0].id;
    await auth.api.setActiveOrganization({
      headers,
      body: { organizationId: targetOrgId },
    });
    log.info({ orgId: targetOrgId }, "Auto-activated organization for user");
    return targetOrgId;
  } catch (err) {
    log.warn({ err }, "Failed to auto-activate organization");
    return null;
  }
}

function clearBetterAuthSessionCacheCookies(cookies: Cookies): void {
  const prefix = serverEnv.ORIGIN.startsWith("https://") ? "__Secure-" : "";
  const baseName = `${prefix}better-auth.session_data`;
  const chunkPrefix = `${baseName}.`;
  for (const { name } of cookies.getAll()) {
    if (name === baseName || name.startsWith(chunkPrefix)) {
      cookies.delete(name, { path: '/' });
    }
  }
}

const defaultDisplaySettings: DisplaySettings = {
  darkMode: false,
  compactView: false,
  showDetailedMetrics: true,
  gettingStartedDismissed: false,
};

async function fetchUserSettings(userId: string): Promise<{ displaySettings: DisplaySettings; temporaryPassword: boolean }> {
  try {
    const [row] = await getDB()
      .select({ displaySettings: userT.displaySettings, temporaryPassword: userT.temporaryPassword })
      .from(userT)
      .where(eq(userT.id, userId))
      .limit(1);
    return {
      displaySettings: row?.displaySettings ?? defaultDisplaySettings,
      temporaryPassword: row?.temporaryPassword ?? false,
    };
  } catch (err) {
    log.warn({ err }, "Failed to fetch display settings");
    return { displaySettings: defaultDisplaySettings, temporaryPassword: false };
  }
}

async function fetchTotalAvailableVramGb(): Promise<number> {
  try {
    const [result] = await getDB()
      .select({ total: sql<number>`coalesce(sum(${aiNodeT.estCapacity}), 0)` })
      .from(aiNodeT)
      .where(and(eq(aiNodeT.available, true), isNull(aiNodeT.deletedAt)));
    return result?.total ?? 0;
  } catch (err) {
    log.warn({ err }, "Failed to sum node VRAM");
    return 0;
  }
}

async function interpretVersion() {
  const newestVersion = await fetchVersion();
  const isNewer = semver.order(newestVersion, version) === 1;
  const isCompatible = semver.satisfies(newestVersion, `^${version}`);
  return {
    minorUpdate: isNewer && isCompatible,
    majorUpdate: isNewer && !isCompatible,
    newestVersion,
    currentVersion: version,
  };
}