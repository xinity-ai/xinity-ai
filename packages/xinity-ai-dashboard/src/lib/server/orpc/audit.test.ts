import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { AuditContext } from "./audit";

const insertValues = mock((_row: unknown) => Promise.resolve());
mock.module("$lib/server/db", () => ({
  getDB: () => ({ insert: () => ({ values: insertValues }) }),
}));

mock.module("$lib/server/logging", () => ({
  rootLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const { runWithAudit } = await import("./audit");

const auditTag = { action: "member.invite", resource: "member" };

function ctx(overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    request: new Request("http://localhost/rpc", { headers: { "user-agent": "test-agent" } }),
    clientAddress: "1.2.3.4",
    actor: { actorType: "user", actorId: "user-1" },
    activeOrganizationId: "org-1",
    ...overrides,
  };
}

describe("runWithAudit", () => {
  beforeEach(() => {
    insertValues.mockClear();
  });

  test("emits a success event after a successful handler", async () => {
    const result = await runWithAudit(ctx(), auditTag, async () => "OK");
    expect(result).toBe("OK");
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0]![0]).toMatchObject({
      organizationId: "org-1",
      actorType: "user",
      actorId: "user-1",
      action: "member.invite",
      resource: "member",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "test-agent",
    });
  });

  test("emits a failure event and rethrows when the handler throws", async () => {
    const err = new Error("boom");
    await expect(runWithAudit(ctx(), auditTag, async () => { throw err; })).rejects.toBe(err);
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0]![0] as { result: string; context: { error: string } };
    expect(row.result).toBe("failure");
    expect(row.context).toMatchObject({ error: "boom" });
  });

  test("does not emit when the procedure has no audit tag", async () => {
    const result = await runWithAudit(ctx(), undefined, async () => "OK");
    expect(result).toBe("OK");
    expect(insertValues).not.toHaveBeenCalled();
  });

  test("swallows a DB write failure without breaking the handler", async () => {
    insertValues.mockImplementationOnce(() => Promise.reject(new Error("db down")));
    const result = await runWithAudit(ctx(), auditTag, async () => "OK");
    expect(result).toBe("OK");
  });

  test("writes an instance-scoped event (null org) when no organization is in context", async () => {
    const result = await runWithAudit(
      ctx({ activeOrganizationId: undefined }),
      auditTag,
      async () => "OK",
    );
    expect(result).toBe("OK");
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0]![0]).toMatchObject({ organizationId: null, actorType: "user" });
  });

  test("attributes the event to an API key when actor is api_key", async () => {
    const c = ctx({ actor: { actorType: "api_key", actorId: "key-1" } });
    await runWithAudit(c, auditTag, async () => "OK");
    const row = insertValues.mock.calls[0]![0] as { actorType: string; actorId: string };
    expect(row.actorType).toBe("api_key");
    expect(row.actorId).toBe("key-1");
  });

  test("falls back to system actor when no actor is on context", async () => {
    const c = ctx({ actor: undefined });
    await runWithAudit(c, auditTag, async () => "OK");
    const row = insertValues.mock.calls[0]![0] as { actorType: string; actorId: string | null };
    expect(row.actorType).toBe("system");
    expect(row.actorId).toBeNull();
  });
});
