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

describe("Deployment input validation", () => {
  const valid = () => {
    const publicSpecifier = `validation-e2e-${randomUUID()}`;
    return { name: publicSpecifier, publicSpecifier, specifier: MODEL, enabled: false };
  };

  test.each([
    ["progress above 100", { progress: 150 }],
    ["negative progress", { progress: -1 }],
    ["fractional replicas", { replicas: 1.5 }],
    ["zero replicas", { replicas: 0 }],
    ["a negative kv cache size", { kvCacheSize: -4 }],
    ["a public name with spaces", { publicSpecifier: "my model" }],
    ["a public name over 128 characters", { publicSpecifier: "m".repeat(129) }],
    ["a public name under 5 characters", { publicSpecifier: "mod" }],
    ["a public name with a slash", { publicSpecifier: "org/model" }],
    ["a public name with a colon", { publicSpecifier: "model:latest" }],
  ])("create refuses %s", async (_, override) => {
    const res = await ownerFetch("/api/deployment/", {
      method: "POST",
      body: JSON.stringify({ ...valid(), ...override }),
    });
    expect(res.status).toBe(400);
  });

  test("create accepts dots and underscores in a public name", async () => {
    const body = { ...valid(), publicSpecifier: `model-${randomUUID()}.v1.2_b` };
    const res = await ownerFetch("/api/deployment/", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as Deployment;
    await ownerFetch(`/api/deployment/${id}`, { method: "DELETE" });
  });

  test("update refuses progress above 100", async () => {
    const created = await ownerFetch("/api/deployment/", { method: "POST", body: JSON.stringify(valid()) });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as Deployment;
    try {
      const res = await ownerFetch(`/api/deployment/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ progress: 150 }),
      });
      expect(res.status).toBe(400);
    } finally {
      await ownerFetch(`/api/deployment/${id}`, { method: "DELETE" });
    }
  });
});
