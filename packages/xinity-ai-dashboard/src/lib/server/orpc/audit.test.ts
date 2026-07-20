import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { AuditContext, AuditTag } from "./audit";

const insertValues = mock((_row: unknown) => Promise.resolve());
mock.module("$lib/server/db", () => ({
  getDB: () => ({ insert: () => ({ values: insertValues }) }),
}));

mock.module("$lib/server/logging", () => ({
  rootLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const { runWithAudit, emitAuthAuditEvent } = await import("./audit");

const auditTag: AuditTag = { action: "member.update_role", resource: "member", resourceId: { fromInput: "memberId" }, captureInput: ["role"] };

function ctx(overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    request: new Request("http://localhost/rpc", { headers: { "user-agent": "test-agent" } }),
    clientAddress: "1.2.3.4",
    actor: { actorType: "user", actorId: "user-1", actorLabel: "user-1@example.com" },
    activeOrganizationId: "org-1",
    ...overrides,
  };
}

describe("runWithAudit", () => {
  beforeEach(() => {
    insertValues.mockClear();
  });

  test("emits a success event after a successful handler", async () => {
    const input = { memberId: "member-42", role: "admin" };
    const result = await runWithAudit(ctx(), auditTag, input, async () => "OK");
    expect(result).toBe("OK");
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0]![0]).toMatchObject({
      organizationId: "org-1",
      actorType: "user",
      actorId: "user-1",
      actorLabel: "user-1@example.com",
      action: "member.update_role",
      resource: "member",
      resourceId: "member-42",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "test-agent",
      context: { role: "admin" },
    });
  });

  test("emits a failure event and rethrows when the handler throws", async () => {
    const err = new Error("boom");
    await expect(runWithAudit(ctx(), auditTag, { memberId: "m-1", role: "admin" }, async () => { throw err; })).rejects.toBe(err);
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0]![0] as { result: string; resourceId: string; context: { role: string; error: string } };
    expect(row.result).toBe("failure");
    expect(row.resourceId).toBe("m-1");
    expect(row.context).toMatchObject({ role: "admin", error: "boom" });
  });

  test("does not emit when the procedure has no audit tag", async () => {
    const result = await runWithAudit(ctx(), undefined, {}, async () => "OK");
    expect(result).toBe("OK");
    expect(insertValues).not.toHaveBeenCalled();
  });

  test("swallows a DB write failure without breaking the handler", async () => {
    insertValues.mockImplementationOnce(() => Promise.reject(new Error("db down")));
    const result = await runWithAudit(ctx(), auditTag, { memberId: "m-1" }, async () => "OK");
    expect(result).toBe("OK");
  });

  test("writes an instance-scoped event (null org) when no organization is in context", async () => {
    const result = await runWithAudit(
      ctx({ activeOrganizationId: undefined }),
      auditTag,
      { memberId: "m-1" },
      async () => "OK",
    );
    expect(result).toBe("OK");
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0]![0]).toMatchObject({ organizationId: null, actorType: "user" });
  });

  test("attributes the event to an API key when actor is api_key", async () => {
    const c = ctx({ actor: { actorType: "api_key", actorId: "key-1", actorLabel: "ci-key" } });
    await runWithAudit(c, auditTag, { memberId: "m-1" }, async () => "OK");
    const row = insertValues.mock.calls[0]![0] as { actorType: string; actorId: string; actorLabel: string };
    expect(row.actorType).toBe("api_key");
    expect(row.actorId).toBe("key-1");
    expect(row.actorLabel).toBe("ci-key");
  });

  test("falls back to system actor when no actor is on context", async () => {
    const c = ctx({ actor: undefined });
    await runWithAudit(c, auditTag, { memberId: "m-1" }, async () => "OK");
    const row = insertValues.mock.calls[0]![0] as { actorType: string; actorId: string | null };
    expect(row.actorType).toBe("system");
    expect(row.actorId).toBeNull();
  });

  test("resolves resourceId from handler output for create operations", async () => {
    const createTag: AuditTag = { action: "aiApplication.create", resource: "aiApplication", resourceId: { fromOutput: "id" } };
    await runWithAudit(ctx(), createTag, {}, async () => ({ id: "new-app-id", name: "Test" }));
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0]![0] as { resourceId: string };
    expect(row.resourceId).toBe("new-app-id");
  });

  test("writes null resourceId when tag has no resourceId config", async () => {
    const plainTag: AuditTag = { action: "account.change_password", resource: "account" };
    await runWithAudit(ctx(), plainTag, {}, async () => "OK");
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0]![0] as { resourceId: string | null };
    expect(row.resourceId).toBeNull();
  });

  test("captures fields from handler output via captureOutput", async () => {
    const tag: AuditTag = { action: "modelDeployment.create", resource: "modelDeployment", captureOutput: ["name", "specifier"] };
    await runWithAudit(ctx(), tag, {}, async () => ({ id: "d-1", name: "GPT", specifier: "gpt-4", extra: "ignored" }));
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(row.context).toEqual({ name: "GPT", specifier: "gpt-4" });
  });

  test("skips undefined input fields in capture", async () => {
    const tag: AuditTag = { action: "apiKey.toggle_enabled", resource: "apiKey", captureInput: ["enabled"] };
    await runWithAudit(ctx(), tag, { id: "k-1" }, async () => "OK");
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0]![0] as { context: unknown };
    expect(row.context).toBeUndefined();
  });

  test("writes null context when no capture is configured", async () => {
    const tag: AuditTag = { action: "apiKey.delete", resource: "apiKey", resourceId: { fromInput: "id" } };
    await runWithAudit(ctx(), tag, { id: "k-1" }, async () => "OK");
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0]![0] as { context: unknown };
    expect(row.context).toBeUndefined();
  });
});

describe("emitAuthAuditEvent", () => {
  beforeEach(() => {
    insertValues.mockClear();
  });

  test("writes a success event with personal scope", async () => {
    emitAuthAuditEvent({
      action: "account.sign_in",
      resource: "account",
      actorId: "user-1",
      actorLabel: "user@example.com",
      ipAddress: "10.0.0.1",
      userAgent: "Mozilla/5.0",
      resourceId: "user-1",
    });
    await Bun.sleep(10);
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0]![0]).toMatchObject({
      organizationId: null,
      actorType: "user",
      actorId: "user-1",
      actorLabel: "user@example.com",
      action: "account.sign_in",
      resource: "account",
      resourceId: "user-1",
      result: "success",
      ipAddress: "10.0.0.1",
      userAgent: "Mozilla/5.0",
      context: null,
    });
  });

  test("records a failure result when specified", async () => {
    emitAuthAuditEvent({
      action: "account.sign_in",
      resource: "account",
      actorId: null,
      actorLabel: "attacker@example.com",
      ipAddress: "192.168.1.1",
      userAgent: "curl/7.0",
      result: "failure",
    });
    await Bun.sleep(10);
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0]![0] as { actorId: string | null; actorLabel: string; result: string; resourceId: string | null };
    expect(row.actorId).toBeNull();
    expect(row.actorLabel).toBe("attacker@example.com");
    expect(row.result).toBe("failure");
    expect(row.resourceId).toBeNull();
  });

  test("swallows DB errors without throwing", async () => {
    insertValues.mockImplementationOnce(() => Promise.reject(new Error("db down")));
    expect(() => {
      emitAuthAuditEvent({
        action: "account.sign_out",
        resource: "account",
        actorId: "user-1",
        actorLabel: null,
        ipAddress: null,
        userAgent: null,
      });
    }).not.toThrow();
  });
});
