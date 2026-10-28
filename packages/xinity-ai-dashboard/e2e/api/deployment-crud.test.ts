import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { ownerFetch } from "./api-helpers";

const MODEL = "apertus-v1.1-0.5b-vllm";

type Deployment = {
  id: string;
  name: string;
  type: "legacy";
  legacy: {
    replicas: number;
    progress: number;
    canaryProgressWithFeedback: boolean;
  };
};

type CreateBody = { name: string; publicSpecifier: string; enabled: boolean; type: "legacy"; legacy: Record<string, unknown> };

describe("Deployment update", () => {
  test("a partial update leaves the fields it does not name untouched", async () => {
    const publicSpecifier = `update-e2e-${randomUUID()}`;
    const created = await ownerFetch("/api/deployments/", {
      method: "POST",
      body: JSON.stringify({
        name: publicSpecifier,
        publicSpecifier,
        enabled: false,
        type: "legacy",
        legacy: {
          specifier: MODEL,
          earlySpecifier: MODEL,
          replicas: 3,
          progress: 30,
          canaryProgressWithFeedback: true,
        },
      }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as Deployment;

    try {
      const res = await ownerFetch(`/api/deployments/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "renamed", enabled: false, publicSpecifier, legacy: { specifier: MODEL } }),
      });
      expect(res.status).toBe(200);
      const updated = (await res.json()) as Deployment;

      expect(updated.name).toBe("renamed");
      expect(updated.type).toBe("legacy");
      expect(updated.legacy.replicas).toBe(3);
      expect(updated.legacy.progress).toBe(30);
      expect(updated.legacy.canaryProgressWithFeedback).toBe(true);
    } finally {
      await ownerFetch(`/api/deployments/${id}`, { method: "DELETE" });
    }
  });
});

describe("Deployment input validation", () => {
  const valid = (): CreateBody => {
    const publicSpecifier = `validation-e2e-${randomUUID()}`;
    return { name: publicSpecifier, publicSpecifier, enabled: false, type: "legacy", legacy: { specifier: MODEL } };
  };
  const withOverride = (override: Partial<CreateBody>): CreateBody => {
    const base = valid();
    return { ...base, ...override, legacy: { ...base.legacy, ...override.legacy } };
  };

  test.each([
    ["progress above 100", { legacy: { progress: 150 } }],
    ["negative progress", { legacy: { progress: -1 } }],
    ["fractional replicas", { legacy: { replicas: 1.5 } }],
    ["zero replicas", { legacy: { replicas: 0 } }],
    ["a negative kv cache size", { legacy: { kvCacheSize: -4 } }],
    ["a public name with spaces", { publicSpecifier: "my model" }],
    ["a public name over 128 characters", { publicSpecifier: "m".repeat(129) }],
    ["a public name under 5 characters", { publicSpecifier: "mod" }],
    ["a public name with a slash", { publicSpecifier: "org/model" }],
    ["a public name with a colon", { publicSpecifier: "model:latest" }],
  ])("create refuses %s", async (_, override) => {
    const res = await ownerFetch("/api/deployments/", {
      method: "POST",
      body: JSON.stringify(withOverride(override)),
    });
    expect(res.status).toBe(400);
  });

  test("create accepts dots and underscores in a public name", async () => {
    const body = withOverride({ publicSpecifier: `model-${randomUUID()}.v1.2_b` });
    const res = await ownerFetch("/api/deployments/", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as Deployment;
    await ownerFetch(`/api/deployments/${id}`, { method: "DELETE" });
  });

  test("update refuses progress above 100", async () => {
    const created = await ownerFetch("/api/deployments/", { method: "POST", body: JSON.stringify(valid()) });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as Deployment;
    try {
      const res = await ownerFetch(`/api/deployments/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ legacy: { progress: 150 } }),
      });
      expect(res.status).toBe(400);
    } finally {
      await ownerFetch(`/api/deployments/${id}`, { method: "DELETE" });
    }
  });
});

describe("Managed deployment", () => {
  type Managed = { id: string; name: string; type: "managed"; managed: { specifier: string; replicas: number; kvCacheSize?: number | null } };

  async function withManaged(managed: Record<string, unknown>, run: (deployment: Managed) => Promise<void>) {
    const publicSpecifier = `managed-e2e-${randomUUID()}`;
    const created = await ownerFetch("/api/deployments/", {
      method: "POST",
      body: JSON.stringify({ name: publicSpecifier, publicSpecifier, enabled: false, type: "managed", managed: { specifier: MODEL, ...managed } }),
    });
    expect(created.status).toBe(200);
    const deployment = (await created.json()) as Managed;
    try {
      await run(deployment);
    } finally {
      await ownerFetch(`/api/deployments/${deployment.id}`, { method: "DELETE" });
    }
  }

  test("a partial update leaves the fields it does not name untouched", () =>
    withManaged({ replicas: 3, kvCacheSize: 4 }, async ({ id, type }) => {
      expect(type).toBe("managed");
      const res = await ownerFetch(`/api/deployments/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "renamed", managed: { kvCacheSize: 6 } }),
      });
      expect(res.status).toBe(200);
      const updated = (await res.json()) as Managed;
      expect(updated.name).toBe("renamed");
      expect(updated.managed.specifier).toBe(MODEL);
      expect(updated.managed.replicas).toBe(3);
      expect(updated.managed.kvCacheSize).toBe(6);
    }));

  test("refuses a patch for another type than the deployment's", () =>
    withManaged({}, async ({ id }) => {
      const res = await ownerFetch(`/api/deployments/${id}`, { method: "PATCH", body: JSON.stringify({ legacy: { replicas: 2 } }) });
      expect(res.status).toBe(400);
    }));

  test("create refuses zero replicas", async () => {
    const publicSpecifier = `managed-e2e-${randomUUID()}`;
    const res = await ownerFetch("/api/deployments/", {
      method: "POST",
      body: JSON.stringify({ name: publicSpecifier, publicSpecifier, enabled: false, type: "managed", managed: { specifier: MODEL, replicas: 0 } }),
    });
    expect(res.status).toBe(400);
  });
});
