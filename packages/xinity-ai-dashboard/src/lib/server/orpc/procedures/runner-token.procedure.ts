import { rootOs, withOrganization, requirePermission } from "../root";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { and, asc, eq, isNull, runnerTokenT } from "common-db";
import { CreatedRunnerTokenDto, RunnerTokenDto } from "$lib/orpc/dtos/runner-token.dto";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "runner-token.procedure" });

const tags = ["Runner Token"];

const SECRET_KIND = "xrt";
/** Random bytes encoded into the public prefix portion of a token. */
const PREFIX_BYTES = 6;
/** Random bytes of the secret-portion that argon2 protects. */
const SECRET_BYTES = 32;

/** Mint a new runner-token secret. The prefix is the row-lookup key; the full plaintext is what argon2 hashes. */
function mintSecret(): { secret: string; prefix: string } {
  const prefix = `${SECRET_KIND}_${randomBytes(PREFIX_BYTES).toString("base64url")}`;
  const secret = `${prefix}_${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { secret, prefix };
}

const createRunnerToken = rootOs
  .use(withOrganization)
  .use(requirePermission({ runnerToken: ["create"] }))
  .route({ path: "/", method: "POST", tags, summary: "Create Runner Token", description: "Mint a long-lived runner token. The plaintext secret is returned exactly once." })
  .input(z.object({
    name: z.string().trim().min(1).describe("Operator-visible label for this token"),
  }))
  .output(CreatedRunnerTokenDto)
  .errors({ CONFLICT: { message: "A runner token with this name already exists" } })
  .handler(async ({ input, context, errors }) => {
    const rlog = log.child({ traceId: context.traceId });
    const { secret, prefix } = mintSecret();
    const hashedSecret = await Bun.password.hash(secret);
    const secretPreview = `${prefix}…`;

    try {
      const [row] = await getDB()
        .insert(runnerTokenT)
        .values({
          organizationId: context.activeOrganizationId,
          name: input.name,
          prefix,
          hashedSecret,
          secretPreview,
          createdByUserId: context.session.user.id,
        })
        .returning();
      rlog.info({ tokenId: row.id, name: row.name }, "Created runner token");
      return {
        id: row.id,
        name: row.name,
        secretPreview: row.secretPreview,
        lastSeenAt: row.lastSeenAt,
        createdAt: row.createdAt,
        secret,
      };
    } catch (err) {
      rlog.error({ err }, "Failed to create runner token");
      throw errors.CONFLICT();
    }
  });

const listRunnerTokens = rootOs
  .use(withOrganization)
  .use(requirePermission({ runnerToken: ["read"] }))
  .route({ path: "/", method: "GET", tags, summary: "List Runner Tokens" })
  .output(RunnerTokenDto.array())
  .handler(async ({ context }) => {
    const rows = await getDB()
      .select({
        id: runnerTokenT.id,
        name: runnerTokenT.name,
        secretPreview: runnerTokenT.secretPreview,
        lastSeenAt: runnerTokenT.lastSeenAt,
        createdAt: runnerTokenT.createdAt,
      })
      .from(runnerTokenT)
      .where(and(
        eq(runnerTokenT.organizationId, context.activeOrganizationId),
        isNull(runnerTokenT.deletedAt),
      ))
      .orderBy(asc(runnerTokenT.createdAt));
    return rows;
  });

const revokeRunnerToken = rootOs
  .use(withOrganization)
  .use(requirePermission({ runnerToken: ["delete"] }))
  .route({ path: "/{id}", method: "DELETE", tags, summary: "Revoke Runner Token" })
  .input(z.object({ id: z.uuid() }))
  .output(z.object({ success: z.literal(true) }))
  .errors({ NOT_FOUND: {} })
  .handler(async ({ input, context, errors }) => {
    const rlog = log.child({ traceId: context.traceId });
    const [row] = await getDB()
      .update(runnerTokenT)
      .set({ deletedAt: new Date() })
      .where(and(
        eq(runnerTokenT.id, input.id),
        eq(runnerTokenT.organizationId, context.activeOrganizationId),
        isNull(runnerTokenT.deletedAt),
      ))
      .returning();
    if (!row) {
      throw errors.NOT_FOUND();
    }
    rlog.info({ tokenId: row.id }, "Revoked runner token");
    return { success: true } as const;
  });

export const runnerTokenRouter = rootOs.prefix("/runner-token").router({
  create: createRunnerToken,
  list: listRunnerTokens,
  revoke: revokeRunnerToken,
});
