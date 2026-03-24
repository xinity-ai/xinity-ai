import { describe, test, expect } from "bun:test";
import { ownerFetch } from "./api-helpers";

/** Subset of API key fields used across these tests. */
interface ApiKeyResponse {
  id: string;
  name: string;
  fullKey: string;
  specifier: string;
  enabled: boolean;
}

let createdKeyId: string;
const suffix = Date.now();

describe("API Key CRUD via /api/api-key", () => {
  test("create an API key", async () => {
    const res = await ownerFetch("/api/api-key/", {
      method: "POST",
      body: JSON.stringify({
        name: `E2E Test Key ${suffix}`,
        enabled: true,
        createApplication: {
          name: `E2E Test App ${suffix}`,
          description: "Created by API test",
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiKeyResponse;
    expect(body.fullKey).toBeTruthy();
    expect(body.name).toBe(`E2E Test Key ${suffix}`);
    expect(body.specifier).toMatch(/^sk_/);
    createdKeyId = body.specifier;
  });

  test("list API keys", async () => {
    const res = await ownerFetch("/api/api-key/", { method: "GET" });

    expect(res.status).toBe(200);
    const keys = (await res.json()) as ApiKeyResponse[];
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThanOrEqual(1);

    const found = keys.find((k) => k.specifier === createdKeyId);
    expect(found).toBeTruthy();
    if (!found) return;

    expect(found.enabled).toBe(true);
    createdKeyId = found.id;
  });

  test("toggle API key enabled state", async () => {
    const res = await ownerFetch(`/api/api-key/${createdKeyId}/toggle-enabled`, {
      method: "POST",
      body: JSON.stringify({ id: createdKeyId, enabled: false }),
    });

    expect(res.status).toBe(200);

    // Verify it's disabled
    const listRes = await ownerFetch("/api/api-key/", { method: "GET" });
    expect(listRes.status).toBe(200);
    const keys = (await listRes.json()) as ApiKeyResponse[];
    const key = keys.find((k) => k.id === createdKeyId);
    expect(key).toBeTruthy();
    if (!key) return;

    expect(key.enabled).toBe(false);
  });

  test("delete API key (soft delete)", async () => {
    const res = await ownerFetch(`/api/api-key/${createdKeyId}`, {
      method: "DELETE",
      body: JSON.stringify({ id: createdKeyId }),
    });

    expect(res.status).toBe(200);

    // Verify it's gone from the list (soft-deleted keys are excluded)
    const listRes = await ownerFetch("/api/api-key/", { method: "GET" });
    const keys = (await listRes.json()) as ApiKeyResponse[];
    const found = keys.find((k) => k.id === createdKeyId);
    expect(found).toBeUndefined();
  });
});
