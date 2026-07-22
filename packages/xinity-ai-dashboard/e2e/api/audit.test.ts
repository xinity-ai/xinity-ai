import { describe, test, expect } from "bun:test";
import { ownerFetch } from "./api-helpers";

describe("Audit trail API", () => {
  test("audit.export rejects without an enterprise license", async () => {
    const from = new Date(Date.now() - 3600_000).toISOString();
    const res = await ownerFetch(`/api/audit/export?from=${encodeURIComponent(from)}`, {
      method: "GET",
    });
    expect(res.status).toBe(403);
  });
});
