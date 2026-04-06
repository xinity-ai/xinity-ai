import { auth } from "$lib/server/auth-server";
import { rootLogger } from "$lib/server/logging";
import { serverEnv, isInstanceAdmin } from "$lib/server/serverenv";
import { getDB } from "$lib/server/db";
import type { LayoutServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
// path to root package version
import {version} from "../../../../../package.json";
import { semver } from "bun";
import { timeCache } from "$lib/util";
import type { RoleName } from "$lib/roles";
import { sql, userT, aiNodeT, type DisplaySettings } from "common-db";
import { getLicenseSummary, hasFeature } from "$lib/server/license";

const log = rootLogger.child({name: "+layout.root"})

export const load: LayoutServerLoad = async ({ request, url, cookies }) => {
  const session = await auth.api.getSession(request);
  if (!session) {
    rootLogger.info({ name: "auth", }, "redirecting")
    const loginUrl = new URL("/login/", url.origin);
    loginUrl.searchParams.set("callbackUrl", url.toString());
    // Promote email to top-level so the login page's URL params store picks it up
    const email = url.searchParams.get("email");
    if (email) {
      loginUrl.searchParams.set("email", email);
      loginUrl.searchParams.set("tab", "signup");
    }
    redirect(302, loginUrl.pathname + loginUrl.search);
  }

  // Auto-activate the first organization if user has orgs but none is active
  if (!session.session.activeOrganizationId && !url.searchParams.has('_orgActivated')) {
    let autoActivated = false;
    try {
      const organizations = await auth.api.listOrganizations({
        headers: request.headers,
      });
      if (organizations && organizations.length > 0) {
        await auth.api.setActiveOrganization({
          headers: request.headers,
          body: { organizationId: organizations[0].id },
        });
        log.info({ orgId: organizations[0].id }, "Auto-activated organization for user");
        autoActivated = true;
      }
    } catch (err) {
      log.warn({ err }, "Failed to auto-activate organization");
    }
    if (autoActivated) {
      // Clear the stale session cookie cache so the next request does a DB lookup.
      // Better Auth prefixes cookie names with __Secure- when baseURL is HTTPS.
      const prefix = serverEnv.ORIGIN.startsWith("https://") ? "__Secure-" : "";
      const cacheCookieName = `${prefix}better-auth.session_data`;
      cookies.delete(cacheCookieName, { path: '/' });
      // Also delete any chunked variants (e.g. .0, .1, …)
      const cookieHeader = request.headers.get("cookie") ?? "";
      for (const part of cookieHeader.split(";")) {
        const name = part.trim().split("=")[0];
        if (name && name.startsWith(cacheCookieName + ".")) {
          cookies.delete(name, { path: '/' });
        }
      }

      // Redirect with a guard param to prevent loops
      const redirectUrl = new URL(url);
      redirectUrl.searchParams.set('_orgActivated', '1');
      redirect(302, redirectUrl.pathname + redirectUrl.search);
    }
  }

  // Fetch the user's role in the active organization
  let memberRole: RoleName | null = null;
  if (session.session.activeOrganizationId) {
    try {
      const activeMember = await auth.api.getActiveMember({
        headers: request.headers,
      });
      if (activeMember?.role) {
        memberRole = activeMember.role as RoleName;
      }
      log.debug({ memberRole, activeMember }, "Active member role loaded");
    } catch (err) {
      log.warn({ err }, "Failed to get active member role");
    }
  }

  // Fetch display settings and temporary password flag
  let displaySettings: DisplaySettings = {
    darkMode: false,
    compactView: false,
    showDetailedMetrics: true,
    gettingStartedDismissed: false,
  };
  let temporaryPassword = false;
  try {
    const [row] = await getDB()
      .select({ displaySettings: userT.displaySettings, temporaryPassword: userT.temporaryPassword })
      .from(userT)
      .where(sql`${userT.id} = ${session.user.id}`)
      .limit(1);
    if (row?.displaySettings) {
      displaySettings = row.displaySettings;
    }
    temporaryPassword = row?.temporaryPassword ?? false;
  } catch (err) {
    log.warn({ err }, "Failed to fetch display settings");
  }

  // Force users with temporary passwords to the password change page
  if (temporaryPassword && !url.pathname.startsWith("/settings/auth")) {
    redirect(302, "/settings/auth");
  }

  // Sum total VRAM across active nodes for license limit warnings
  let totalVramGb = 0;
  try {
    const [result] = await getDB()
      .select({ total: sql<number>`coalesce(sum(${aiNodeT.estCapacity}), 0)` })
      .from(aiNodeT)
      .where(sql`${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`);
    totalVramGb = result?.total ?? 0;
  } catch (err) {
    log.warn({ err }, "Failed to sum node VRAM");
  }

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

const fetchVersion = timeCache(1000 * 60 * 5, async function(){
  const res = await fetch(new URL("/version.json", serverEnv.INFOSERVER_URL), {signal: AbortSignal.timeout(5000)});
  if(!res.ok){
    log.warn("Unable to reach infoserver to retrieve version");
    
    return version // Reporting current version, as if up to date
  }
  const json = await res.json();
  if("version" in json && typeof json.version === "string"){
    return json.version as string;
  }

  log.warn("Unable to extract version from version request output.");
  return version // Reporting current version, as if up to date
})

async function interpretVersion(){
  const newestVersion = await fetchVersion();
  const isNewer = semver.order(newestVersion, version) === 1;
  const majorUpdate = isNewer && !semver.satisfies(newestVersion, `^${version}`);
  const minorUpdate = isNewer && semver.satisfies(newestVersion, `^${version}`);
  return {minorUpdate, majorUpdate, newestVersion, currentVersion: version}
}