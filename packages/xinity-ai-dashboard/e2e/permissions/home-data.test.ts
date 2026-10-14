import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { ownerFetch } from "../api/api-helpers";
import { ensureE2EReady } from "../guard";
import { BASE_URL, STORAGE_STATE, VIEWER, type StorageState } from "../utils/test-data";

type Member = { id: string; role: string; user: { email: string } };

let viewerCookies = "";
let viewerMemberId = "";

async function setViewerRole(role: string): Promise<void> {
  const res = await ownerFetch("/api/organization/member", {
    method: "PATCH",
    body: JSON.stringify({ memberId: viewerMemberId, role }),
  });
  if (!res.ok) {
    throw new Error(`Setting the viewer role to ${role} failed: ${res.status} ${await res.text()}`);
  }
}

/** Reads the streamed checklist out of the home page's devalue-encoded `__data.json`. */
async function viewerSeesApplication(): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/__data.json`, { headers: { Cookie: viewerCookies } });
  expect(res.status).toBe(200);
  for (const line of (await res.text()).split("\n").filter(Boolean)) {
    const message = JSON.parse(line) as { type: string; data?: unknown[] };
    const [head] = message.data ?? [];
    if (message.type === "chunk" && head && typeof head === "object" && "hasApplication" in head) {
      return message.data![(head as { hasApplication: number }).hasApplication] === true;
    }
  }
  throw new Error("The home page data carried no checklist");
}

describe("Home page data follows the member's permissions", () => {
  beforeAll(async () => {
    await ensureE2EReady();
    const storageState = JSON.parse(readFileSync(STORAGE_STATE.viewer, "utf-8")) as StorageState;
    viewerCookies = storageState.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const created = await ownerFetch("/api/api-key/", {
      method: "POST",
      body: JSON.stringify({ name: `Home data key ${Date.now()}`, enabled: true, createApplication: { name: `Home data app ${Date.now()}` } }),
    });
    expect(created.status).toBe(200);

    const org = await ownerFetch("/api/auth/organization/get-full-organization");
    const { members } = (await org.json()) as { members: Member[] };
    viewerMemberId = members.find((m) => m.user.email === VIEWER.email)!.id;
  });

  afterAll(async () => {
    await setViewerRole("viewer");
  });

  test("a viewer gets the organization's overview", async () => {
    expect(await viewerSeesApplication()).toBe(true);
  });

  test("a pending member gets none of it", async () => {
    await setViewerRole("pending");
    expect(await viewerSeesApplication()).toBe(false);
  });
});
