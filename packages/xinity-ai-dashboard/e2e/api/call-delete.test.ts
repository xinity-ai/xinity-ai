import { describe, test, expect, beforeAll } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chatMessageT,
  inferenceCallMessageT,
  inferenceCallT,
  preconfigureDB,
  inArray,
  and,
  eq,
} from "common-db";
import { jsonDigest } from "common-env";
import { ownerFetch, getSetupState } from "./api-helpers";
import { ensureE2EReady } from "../guard";

let db: ReturnType<ReturnType<typeof preconfigureDB>["getDB"]>;
let orgId: string;

beforeAll(async () => {
  await ensureE2EReady();
  if (!process.env.DB_CONNECTION_URL) {
    throw new Error("DB_CONNECTION_URL not set; copy example.env to .env at the repo root");
  }
  db = preconfigureDB(process.env.DB_CONNECTION_URL).getDB();
  orgId = (await getSetupState()).orgId;
});

/** A call referencing the given bodies, in order. */
async function seedCall(bodies: unknown[]): Promise<string> {
  const [call] = await db
    .insert(inferenceCallT)
    .values({
      organizationId: orgId,
      endpoint: "chat_completions",
      servedModel: "delete-test",
      publicSpecifier: "delete-test",
      durationMs: 1,
    })
    .returning({ id: inferenceCallT.id });

  const ids: string[] = [];
  for (const body of bodies) {
    const sha256 = jsonDigest(body);
    const [existing] = await db
      .select({ id: chatMessageT.id })
      .from(chatMessageT)
      .where(and(eq(chatMessageT.organizationId, orgId), eq(chatMessageT.sha256, sha256)));
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const [row] = await db
      .insert(chatMessageT)
      .values({ organizationId: orgId, sha256, body: body as never })
      .returning({ id: chatMessageT.id });
    ids.push(row!.id);
  }

  await db.insert(inferenceCallMessageT).values(ids.map((messageId, seq) => ({
    callId: call!.id,
    seq,
    messageId,
    direction: "input" as const,
  })));

  return call!.id;
}

const remaining = async (ids: string[]) =>
  (await db.select({ id: chatMessageT.id }).from(chatMessageT).where(inArray(chatMessageT.id, ids)))
    .map((row) => row.id);

describe("deleting a call", () => {
  test("removes the bodies it alone referenced and keeps the shared ones", async () => {
    const run = randomUUID();
    const shared = { role: "system", content: `shared ${run}` };
    const exclusive = { role: "user", content: `exclusive ${run}` };

    const doomed = await seedCall([shared, exclusive]);
    await seedCall([shared]);

    const [sharedId, exclusiveId] = await Promise.all(
      [shared, exclusive].map(async (body) => {
        const [row] = await db
          .select({ id: chatMessageT.id })
          .from(chatMessageT)
          .where(and(eq(chatMessageT.organizationId, orgId), eq(chatMessageT.sha256, jsonDigest(body))));
        return row!.id;
      }),
    );

    expect(await remaining([sharedId, exclusiveId])).toHaveLength(2);

    const res = await ownerFetch("/api/api-call/", {
      method: "DELETE",
      body: JSON.stringify({ apiCallIds: [doomed] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });

    expect(await remaining([exclusiveId])).toEqual([]);
    expect(await remaining([sharedId])).toEqual([sharedId]);
  });
});
