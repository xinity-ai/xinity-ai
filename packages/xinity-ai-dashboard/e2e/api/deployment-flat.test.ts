import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { ownerFetch } from "./api-helpers";

const MODEL = "apertus-v1.1-0.5b-vllm";

type FlatDeployment = { id: string; name: string; specifier: string; replicas: number; progress: number };

describe("deprecated flat deployment API", () => {
  test("creates, reads, updates and deletes a deployment in the flat shape", async () => {
    const publicSpecifier = `flat-e2e-${randomUUID()}`;
    const created = await ownerFetch("/api/deployment/", {
      method: "POST",
      body: JSON.stringify({ name: publicSpecifier, publicSpecifier, specifier: MODEL, enabled: false, replicas: 2, progress: 40 }),
    });
    expect(created.status).toBe(200);
    const { id, specifier } = (await created.json()) as FlatDeployment;
    expect(specifier).toBe(MODEL);

    try {
      const updated = await ownerFetch(`/api/deployment/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "renamed", progress: 60 }),
      });
      expect(updated.status).toBe(200);

      const read = await ownerFetch(`/api/deployment/${id}`);
      expect(read.status).toBe(200);
      const deployment = (await read.json()) as FlatDeployment;
      expect(deployment.name).toBe("renamed");
      expect(deployment.specifier).toBe(MODEL);
      expect(deployment.replicas).toBe(2);
      expect(deployment.progress).toBe(60);
    } finally {
      const deleted = await ownerFetch(`/api/deployment/${id}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
    }
  });

  test("previews capacity for a flat draft", async () => {
    const res = await ownerFetch("/api/deployment/check-capacity", {
      method: "POST",
      body: JSON.stringify({ specifier: MODEL, replicas: 1 }),
    });
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { deployable: boolean }).deployable).toBe("boolean");
  });
});
