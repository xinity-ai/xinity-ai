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

  test("audit.export refuses to run unbounded", async () => {
    const res = await ownerFetch("/api/audit/export", { method: "GET" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(403);
  });

  test("the reconciliation stream is not reachable as an organization owner", async () => {
    const res = await ownerFetch("/api/instance-admin/audit-stream?fromStreamPosition=1", { method: "GET" });
    expect(res.status).toBe(403);
  });
});
