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

type Managed = { id: string; name: string; type: "managed"; managed: { specifier: string; replicas: number; kvCacheSize?: number | null } };

type Member = { specifier: string; kvCacheSize?: number | null };
type Canary = { id: string; type: "canary"; canary: { replicas: number; progress: number; advance: { type: string; startProgress?: number }; from: Member; to: Member } };

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

describe("Managed deployment", () => {
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

describe("Rollout", () => {
  const rollout = (id: string, body: Record<string, unknown>) =>
    ownerFetch(`/api/deployments/${id}/rollout`, { method: "POST", body: JSON.stringify(body) });
  const startCanary = (id: string, canary: Record<string, unknown> = {}) =>
    rollout(id, { type: "canary", canary: { to: { specifier: MODEL, kvCacheSize: 6 }, progress: 30, ...canary } });
  const endCanary = (id: string, keep: "from" | "to") => rollout(id, { type: "managed", managed: { keep } });

  test("starting a canary keeps the deployment and gives its replicas to the rollout", () =>
    withManaged({ replicas: 3, kvCacheSize: 4 }, async ({ id }) => {
      const res = await startCanary(id);
      expect(res.status).toBe(200);
      const started = (await res.json()) as Canary;
      expect(started.id).toBe(id);
      expect(started.type).toBe("canary");
      expect(started.canary.replicas).toBe(3);
      expect(started.canary.progress).toBe(30);
      expect(started.canary.advance.type).toBe("manual");
      expect(started.canary.from.kvCacheSize).toBe(4);
      expect(started.canary.to.kvCacheSize).toBe(6);
    }));

  test("a time-based advance moves on from the progress the rollout starts at", () =>
    withManaged({}, async ({ id }) => {
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const res = await startCanary(id, { advance: { type: "time", until } });
      expect(res.status).toBe(200);
      const { canary } = (await res.json()) as Canary;
      expect(canary.advance.type).toBe("time");
      expect(canary.advance.startProgress).toBe(30);
    }));

  test("a partial update of a canary leaves the fields it does not name untouched", () =>
    withManaged({ replicas: 3, kvCacheSize: 4 }, async ({ id }) => {
      expect((await startCanary(id)).status).toBe(200);
      const res = await ownerFetch(`/api/deployments/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "renamed", canary: { to: { kvCacheSize: 8 } } }),
      });
      expect(res.status).toBe(200);
      const updated = (await res.json()) as Canary;
      expect(updated.canary.replicas).toBe(3);
      expect(updated.canary.progress).toBe(30);
      expect(updated.canary.from.kvCacheSize).toBe(4);
      expect(updated.canary.to.kvCacheSize).toBe(8);
    }));

  test("keeping `to` leaves a managed deployment of the new model with all replicas", () =>
    withManaged({ replicas: 2, kvCacheSize: 4 }, async ({ id }) => {
      expect((await startCanary(id)).status).toBe(200);
      const res = await endCanary(id, "to");
      expect(res.status).toBe(200);
      const promoted = (await res.json()) as Managed;
      expect(promoted.id).toBe(id);
      expect(promoted.type).toBe("managed");
      expect(promoted.managed.replicas).toBe(2);
      expect(promoted.managed.kvCacheSize).toBe(6);
    }));

  test("keeping `from` returns to the model traffic was moving away from", () =>
    withManaged({ kvCacheSize: 4 }, async ({ id }) => {
      expect((await startCanary(id)).status).toBe(200);
      const res = await endCanary(id, "from");
      expect(res.status).toBe(200);
      const rolledBack = (await res.json()) as Managed;
      expect(rolledBack.type).toBe("managed");
      expect(rolledBack.managed.kvCacheSize).toBe(4);
    }));

  test("refuses to end a rollout on a managed deployment", () =>
    withManaged({}, async ({ id }) => {
      expect((await endCanary(id, "to")).status).toBe(400);
    }));

  test("refuses to start a canary on a canary", () =>
    withManaged({}, async ({ id }) => {
      expect((await startCanary(id)).status).toBe(200);
      expect((await startCanary(id)).status).toBe(400);
    }));

  test("refuses a patch for another type than the deployment's", () =>
    withManaged({}, async ({ id }) => {
      expect((await startCanary(id)).status).toBe(200);
      const res = await ownerFetch(`/api/deployments/${id}`, { method: "PATCH", body: JSON.stringify({ managed: { replicas: 2 } }) });
      expect(res.status).toBe(400);
    }));

  test("starting a canary refuses progress above 100", () =>
    withManaged({}, async ({ id }) => {
      expect((await startCanary(id, { progress: 150 })).status).toBe(400);
    }));
});
