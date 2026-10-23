import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { ownerFetch } from "./api-helpers";

const MODEL = "apertus-v1.1-0.5b-vllm";

type Deployment = {
  id: string;
  name: string;
  replicas: number;
  progress: number;
  canaryProgressWithFeedback: boolean;
};

describe("Deployment update", () => {
  test("a partial update leaves the fields it does not name untouched", async () => {
    const publicSpecifier = `update-e2e-${randomUUID()}`;
    const created = await ownerFetch("/api/deployment/", {
      method: "POST",
      body: JSON.stringify({
        name: publicSpecifier,
        publicSpecifier,
        specifier: MODEL,
        earlySpecifier: MODEL,
        enabled: false,
        replicas: 3,
        progress: 30,
        canaryProgressWithFeedback: true,
      }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as Deployment;

    try {
      const res = await ownerFetch(`/api/deployment/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "renamed", enabled: false, publicSpecifier, specifier: MODEL }),
      });
      expect(res.status).toBe(200);
      const updated = (await res.json()) as Deployment;

      expect(updated.name).toBe("renamed");
      expect(updated.replicas).toBe(3);
      expect(updated.progress).toBe(30);
      expect(updated.canaryProgressWithFeedback).toBe(true);
    } finally {
      await ownerFetch(`/api/deployment/${id}`, { method: "DELETE" });
    }
  });
});
