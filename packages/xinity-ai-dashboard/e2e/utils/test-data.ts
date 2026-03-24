import { join } from "path";

export const OWNER = {
  name: "E2E Owner",
  email: "e2e-owner@xinity-test.local",
  password: "TestPassword123!",
} as const;

export const VIEWER = {
  name: "E2E Viewer",
  email: "e2e-viewer@xinity-test.local",
  password: "TestPassword123!",
} as const;

export const TEST_ORG = {
  name: "E2E Test Org",
  slug: "e2e-test-org",
} as const;

const AUTH_DIR = join(import.meta.dirname, "..", ".auth");

export const STORAGE_STATE = {
  owner: join(AUTH_DIR, "owner.json"),
  viewer: join(AUTH_DIR, "viewer.json"),
} as const;

export const API_KEY_STATE = join(AUTH_DIR, "api-key.json");

export const MAILHOG_API = "http://localhost:8025/api";

export const BASE_URL = "http://localhost:5173";

/** Shape of Playwright storage state files written by global-setup. */
export interface StorageState {
  cookies: Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite: "Lax" | "Strict" | "None" }>;
  origins: unknown[];
}
