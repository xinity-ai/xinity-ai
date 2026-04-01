import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { ensureE2EReady } from "../guard";
import { getSetupState } from "./api-helpers";
import { BASE_URL, STORAGE_STATE, type StorageState } from "../utils/test-data";

const MCP_URL = `${BASE_URL}/mcp`;

// ─── Helpers ────────────────────────────────────────────────────────

function jsonRpc(method: string, params?: Record<string, unknown>, id: number = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function mcpFetch(body: unknown, apiKey?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
}

async function mcpJson(body: unknown, apiKey?: string): Promise<Record<string, unknown>> {
  const res = await mcpFetch(body, apiKey);
  return (await res.json()) as Record<string, unknown>;
}

/** Create a dashboard API key for the given user session cookies. */
async function createDashboardApiKey(cookies: string, orgId: string, name: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/account/dashboard-api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: BASE_URL,
      Cookie: cookies,
    },
    body: JSON.stringify({ name, organizationId: orgId }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create dashboard API key: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { key: string };
  return data.key;
}

// ─── Known excluded tool names (procedures with meta({ mcp: false })) ───

const EXCLUDED_TOOLS = [
  "account_changePassword",
  "account_listPasskeys",
  "account_deletePasskey",
  "account_listDashboardApiKeys",
  "account_createDashboardApiKey",
  "account_deleteDashboardApiKey",
  "sso_registerOidc",
  "sso_registerSaml",
  "sso_deleteProvider",
  "organization_deleteOrganization",
  "onboarding_setupOnboarding",
  "onboarding_cli",
  "instanceAdmin_listUsers",
  "instanceAdmin_banUser",
  "instanceAdmin_unbanUser",
  "instanceAdmin_addUserToOrganization",
  "instanceAdmin_removeUserFromOrganization",
  "instanceAdmin_updateUserRole",
  "instanceAdmin_listOrganizations",
  "instanceAdmin_getOrganizationMembers",
  "instanceAdmin_setSsoSelfManage",
  "apiCall_addExampleCalls",
];

// ─── Setup ──────────────────────────────────────────────────────────

let ownerApiKey: string;
let viewerApiKey: string;
let toolNames: string[];

beforeAll(async () => {
  await ensureE2EReady();

  const state = await getSetupState();

  // Owner API key from setup
  ownerApiKey = state.ownerApiKey;
  if (!ownerApiKey) {
    // Recovery mode: create one via session cookies
    const ownerState = JSON.parse(readFileSync(STORAGE_STATE.owner, "utf-8")) as StorageState;
    const ownerCookies = ownerState.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    ownerApiKey = await createDashboardApiKey(ownerCookies, state.orgId, "MCP Test Owner Key");
  }

  // Viewer API key: always create fresh
  if (!existsSync(STORAGE_STATE.viewer)) {
    throw new Error(`Viewer storage state not found at ${STORAGE_STATE.viewer}. Run setup first.`);
  }
  const viewerState = JSON.parse(readFileSync(STORAGE_STATE.viewer, "utf-8")) as StorageState;
  const viewerCookies = viewerState.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  viewerApiKey = await createDashboardApiKey(viewerCookies, state.orgId, "MCP Test Viewer Key");

  // Pre-fetch the tool list once for visibility tests
  const res = await mcpJson(jsonRpc("tools/list"), ownerApiKey);
  const result = res.result as { tools: Array<{ name: string }> };
  toolNames = result.tools.map((t) => t.name);
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("MCP tool visibility", () => {
  test("tools/list does not contain excluded procedures", () => {
    for (const excluded of EXCLUDED_TOOLS) {
      expect(toolNames).not.toContain(excluded);
    }
  });

  test("tools/list contains expected included tools", () => {
    expect(toolNames).toContain("apiKey_list");
    expect(toolNames).toContain("apiKey_create");
    expect(toolNames).toContain("deployment_list");
    expect(toolNames).toContain("application_list");
    expect(toolNames).toContain("health");
  });

  test("tools/call with excluded tool name returns unknown tool error", async () => {
    const res = await mcpJson(
      jsonRpc("tools/call", { name: "account_changePassword", arguments: {} }),
      ownerApiKey,
    );
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });
});

describe("MCP permission enforcement", () => {
  test("owner can call apiKey_list via MCP", async () => {
    const res = await mcpJson(
      jsonRpc("tools/call", { name: "apiKey_list", arguments: {} }),
      ownerApiKey,
    );
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    // Result should be parseable JSON (array of API keys)
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("viewer cannot call apiKey_create via MCP", async () => {
    const res = await mcpJson(
      jsonRpc("tools/call", {
        name: "apiKey_create",
        arguments: { name: "Should Fail Key", enabled: true },
      }),
      viewerApiKey,
    );
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
  });

  test("request without API key returns unauthorized error", async () => {
    const res = await mcpJson(
      jsonRpc("tools/call", { name: "apiKey_list", arguments: {} }),
      // no API key
    );
    const error = res.error as { code: number; message: string };
    expect(error.code).toBe(-32001);
    expect(error.message).toContain("Unauthorized");
  });
});
