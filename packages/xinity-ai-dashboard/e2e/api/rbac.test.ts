import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { ownerFetch } from "./api-helpers";
import { ensureE2EReady } from "../guard";
import { STORAGE_STATE, BASE_URL } from "../utils/test-data";
import type { StorageState } from "../utils/test-data";

/** Subset of API key fields used across these tests. */
interface ApiKeyResponse {
  id: string;
  name: string;
  fullKey: string;
  specifier: string;
  enabled: boolean;
}

let viewerCookies: string;

async function viewerFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: BASE_URL,
      Cookie: viewerCookies,
      ...init?.headers,
    },
  });
}

beforeAll(async () => {
  await ensureE2EReady();

  if (!existsSync(STORAGE_STATE.viewer)) {
    throw new Error(`Viewer storage state not found at ${STORAGE_STATE.viewer}. Run setup first.`);
  }

  const storageState = JSON.parse(readFileSync(STORAGE_STATE.viewer, "utf-8")) as StorageState;
  viewerCookies = storageState.cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
});

const suffix = Date.now();

describe("RBAC enforcement", () => {
  test("owner can create API keys", async () => {
    const res = await ownerFetch("/api/api-key/", {
      method: "POST",
      body: JSON.stringify({
        name: `RBAC Test Key ${suffix}`,
        enabled: true,
        createApplication: {
          name: `RBAC Test App ${suffix}`,
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiKeyResponse;
    expect(body.fullKey).toBeTruthy();
  });

  test("viewer cannot create API keys", async () => {
    const res = await viewerFetch("/api/api-key/", {
      method: "POST",
      body: JSON.stringify({
        name: "Should Fail Key",
        enabled: true,
      }),
    });

    // Should be forbidden (viewer has no apiKey create permission)
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("viewer cannot delete API keys", async () => {
    // First create a key as owner
    await ownerFetch("/api/api-key/", {
      method: "POST",
      body: JSON.stringify({
        name: `Key To Not Delete ${suffix}`,
        enabled: true,
      }),
    });

    // Get the key's ID from the list as owner
    const listRes = await ownerFetch("/api/api-key/", { method: "GET" });
    expect(listRes.status).toBe(200);
    const keys = (await listRes.json()) as ApiKeyResponse[];
    expect(Array.isArray(keys)).toBe(true);
    const targetKey = keys.find((k) => k.name === `Key To Not Delete ${suffix}`);

    if (targetKey) {
      const deleteRes = await viewerFetch(`/api/api-key/${targetKey.id}`, {
        method: "DELETE",
        body: JSON.stringify({ id: targetKey.id }),
      });

      expect(deleteRes.status).toBeGreaterThanOrEqual(400);
      expect(deleteRes.status).toBeLessThan(500);
    }
  });

  test("viewer cannot list API keys", async () => {
    // viewer role does NOT have apiKey read permission
    const res = await viewerFetch("/api/api-key/", { method: "GET" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
