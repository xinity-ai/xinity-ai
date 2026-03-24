/**
 * Shared helpers for dashboard API tests.
 * Reuses the session cookies saved by global-setup (owner.json) to avoid
 * creating extra sessions that would invalidate the browser tests' state.
 */
import { existsSync, readFileSync } from "fs";
import { API_KEY_STATE, STORAGE_STATE, BASE_URL, type StorageState } from "../utils/test-data";
import { ensureE2EReady } from "../guard";

export interface SetupState {
  ownerApiKey: string;
  orgId: string;
  orgSlug: string;
}

let _state: SetupState | null = null;
let _ownerCookies: string | null = null;

export async function getSetupState(): Promise<SetupState> {
  await ensureE2EReady();

  if (_state) return _state;

  if (!existsSync(API_KEY_STATE)) {
    throw new Error(`Setup state not found at ${API_KEY_STATE}. Run setup first.`);
  }

  const parsed = JSON.parse(readFileSync(API_KEY_STATE, "utf-8")) as SetupState;
  if (!parsed.orgId) {
    throw new Error("Org ID is empty. Setup may have failed. Delete .auth/ and re-run.");
  }
  _state = parsed;
  return parsed;
}

/** Load owner cookies from the saved storage state (same session as browser tests). */
async function getOwnerCookies(): Promise<string> {
  if (_ownerCookies) return _ownerCookies;

  await ensureE2EReady();

  if (!existsSync(STORAGE_STATE.owner)) {
    throw new Error(`Owner storage state not found at ${STORAGE_STATE.owner}. Run setup first.`);
  }

  const storageState = JSON.parse(readFileSync(STORAGE_STATE.owner, "utf-8")) as StorageState;
  _ownerCookies = storageState.cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  return _ownerCookies;
}

export function apiUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

/** Make an authenticated request to the dashboard API as the owner. */
export async function ownerFetch(path: string, init?: RequestInit): Promise<Response> {
  const cookies = await getOwnerCookies();
  return fetch(apiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: BASE_URL,
      Cookie: cookies,
      ...init?.headers,
    },
  });
}
