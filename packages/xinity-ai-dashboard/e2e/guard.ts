/**
 * E2E test guard: ensures the dashboard is running and auth state exists.
 * Call from beforeAll or from getBrowser(). Idempotent, safe to call multiple times.
 */
import { existsSync, readFileSync } from "fs";
import { STORAGE_STATE, API_KEY_STATE, BASE_URL, type StorageState } from "./utils/test-data";
import { runSetup } from "./global-setup";

let ready = false;

/** Check whether the owner session cookie is still valid by calling get-session. */
async function isSessionAlive(): Promise<boolean> {
  if (!existsSync(STORAGE_STATE.owner)) return false;

  try {
    const storageState = JSON.parse(readFileSync(STORAGE_STATE.owner, "utf-8")) as StorageState;
    const cookieStr = storageState.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const res = await fetch(`${BASE_URL}/api/auth/get-session`, {
      headers: { Cookie: cookieStr, Origin: BASE_URL },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) return false;
    const session = (await res.json()) as { user?: { id: string } };
    return !!session?.user?.id;
  } catch {
    return false;
  }
}

export async function ensureE2EReady(): Promise<void> {
  if (ready) return;

  // 1. Check dev server is running
  try {
    const res = await fetch(BASE_URL, {
      signal: AbortSignal.timeout(3_000),
      redirect: "manual",
    });
    if (!res.ok && res.status !== 302) {
      throw new Error(`Unexpected status: ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `Dashboard not running at ${BASE_URL}. Start with: bun run dev\n  Original error: ${err}`,
    );
  }

  // 2. Run setup if auth state is missing, invalid, or expired
  let needsSetup = false;

  if (!existsSync(STORAGE_STATE.owner) || !existsSync(STORAGE_STATE.viewer) || !existsSync(API_KEY_STATE)) {
    needsSetup = true;
  } else {
    try {
      const state = JSON.parse(await Bun.file(API_KEY_STATE).text()) as { orgId?: string };
      if (!state.orgId) {
        needsSetup = true;
      }
    } catch {
      needsSetup = true;
    }
  }

  if (!needsSetup) {
    // Files exist and look valid, but the session may have expired
    const alive = await isSessionAlive();
    if (!alive) {
      console.log("  Session cookies expired, re-running setup...");
      needsSetup = true;
    }
  }

  if (needsSetup) {
    console.log("  Auth state missing or invalid, running setup...");
    await runSetup();
  }

  ready = true;
}
