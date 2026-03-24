/**
 * E2E test guard: ensures the dashboard is running and auth state exists.
 * Call from beforeAll or from getBrowser(). Idempotent, safe to call multiple times.
 */
import { existsSync } from "fs";
import { STORAGE_STATE, API_KEY_STATE, BASE_URL } from "./utils/test-data";
import { runSetup } from "./global-setup";

let ready = false;

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

  // 2. Run setup if auth state is missing or invalid
  let needsSetup = false;

  if (!existsSync(STORAGE_STATE.owner) || !existsSync(STORAGE_STATE.viewer) || !existsSync(API_KEY_STATE)) {
    needsSetup = true;
  } else {
    // Check if api-key.json has valid data (not empty from a failed previous run)
    try {
      const state = JSON.parse(await Bun.file(API_KEY_STATE).text()) as { orgId?: string };
      if (!state.orgId) {
        needsSetup = true;
      }
    } catch {
      needsSetup = true;
    }
  }

  if (needsSetup) {
    console.log("  Auth state missing or invalid, running setup...");
    await runSetup();
  }

  ready = true;
}
