import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { apiResponseT, organizationT } from "common-db";
import { redis } from "../redis";
import { getDB } from "../db";
import { deleteResponse, getResponse, saveResponse } from "./response-store";
import type { ResponseObject } from "./responses/schemas";
import { CreateResponseBodySchema } from "./responses/schemas";
import { createResponseObject } from "./responses/response-object";

// eslint-disable-next-line no-restricted-properties -- opt-in integration test gate
const enabled = Boolean(Bun.env.DB_CONNECTION_URL && Bun.env.REDIS_URL);
const dbResponseId = crypto.randomUUID();
const responseId = `resp_${dbResponseId}`;
const raceDbResponseId = crypto.randomUUID();
const raceResponseId = `resp_${raceDbResponseId}`;
let orgId: string | undefined;

function makeResponse(status: ResponseObject["status"], id = responseId): ResponseObject {
  return createResponseObject({
    responseId: id,
    createdAt: Math.floor(Date.now() / 1000),
    model: "integration-test-model",
    status,
    body: CreateResponseBodySchema.parse({
      model: "integration-test-model",
      input: "integration test",
    }),
  });
}

describe.skipIf(!enabled)("response deletion integration (PostgreSQL + Redis)", () => {
  beforeAll(async () => {
    const [org] = await getDB().select({ id: organizationT.id }).from(organizationT).limit(1);
    if (!org) throw new Error("Integration test requires an existing organization in PostgreSQL");
    orgId = org.id;
  });

  afterAll(async () => {
    if (!orgId) return;
    for (const id of [responseId, raceResponseId]) {
      await redis.del(`response:${orgId}:${id}`).catch(() => undefined);
    }
  });

  it("does not resurrect a response after deletion when late completion arrives", async () => {
    if (!orgId) throw new Error("Organization setup did not complete");

    await saveResponse(orgId, responseId, makeResponse("in_progress"), {
      apiKeyId: null, applicationId: null, inferenceCallId: null, inputMessages: [],
    });
    expect(await getResponse(orgId, responseId)).not.toBeNull();

    expect(await deleteResponse(orgId, responseId)).toBe(true);
    await saveResponse(orgId, responseId, makeResponse("completed"));

    expect(await getResponse(orgId, responseId)).toBeNull();
  });

  it("does not resurrect a response when deletion races with completion", async () => {
    if (!orgId) throw new Error("Organization setup did not complete");

    await saveResponse(orgId, raceResponseId, makeResponse("in_progress", raceResponseId), {
      apiKeyId: null,
      applicationId: null,
      inferenceCallId: null,
      inputMessages: [],
    });

    const [deleted] = await Promise.all([
      deleteResponse(orgId, raceResponseId),
      saveResponse(orgId, raceResponseId, makeResponse("completed", raceResponseId)),
    ]);

    expect(deleted).toBe(true);
    expect(await getResponse(orgId, raceResponseId)).toBeNull();

    const responseRows = await getDB().select().from(apiResponseT).where(
      and(eq(apiResponseT.organizationId, orgId), eq(apiResponseT.id, raceDbResponseId)),
    );
    expect(responseRows).toHaveLength(0);
  });
});
