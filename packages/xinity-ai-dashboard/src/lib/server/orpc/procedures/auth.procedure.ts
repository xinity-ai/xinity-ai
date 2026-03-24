import { rootOs, withAuth } from "../root";
import { z } from "zod";
import { auth, getGreenlitCallId } from "$lib/server/auth-server";
import { rootLogger } from "$lib/server/logging";
import { getDB } from "$lib/server/db";
import { memberT, sql } from "common-db";

const log = rootLogger.child({ name: "auth.procedure" });
const tags = ["Auth"];

const changePassword = rootOs
  .meta({ mcp: false })
  .use(withAuth)
  .route({ path: "/change-password", method: "POST", tags, summary: "Change Password" })
  .input(z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  }))
  .handler(async ({ context, input, errors }) => {
    try {
      await auth.api.changePassword({
        headers: context.request.headers,
        body: {
          currentPassword: input.currentPassword,
          newPassword: input.newPassword,
        },
      });
      return { success: true };
    } catch (error: any) {
      log.error(error, "Error during password change");
      throw errors.UNAUTHORIZED({
        message: error?.body?.message || error?.message || "Failed to change password",
      });
    }
  });

const listPasskeys = rootOs
  .meta({ mcp: false })
  .use(withAuth)
  .route({ path: "/passkeys", method: "GET", tags, summary: "List Passkeys" })
  .handler(async ({ context }) => {
    return await auth.api.listPasskeys({
      headers: context.request.headers,
    });
  });

const deletePasskey = rootOs
  .meta({ mcp: false })
  .use(withAuth)
  .route({ path: "/passkeys", method: "DELETE", tags, summary: "Delete Passkey" })
  .input(z.object({ id: z.string() }))
  .handler(async ({ context, input, errors }) => {
    try {
      await auth.api.deletePasskey({
        headers: context.request.headers,
        body: { id: input.id },
      });
      return { success: true };
    } catch (error) {
      log.error(error, "Error deleting passkey");
      throw errors.INTERNAL_SERVER_ERROR({ message: "Failed to delete passkey" });
    }
  });

const listDashboardApiKeys = rootOs
  .meta({ mcp: false })
  .use(withAuth)
  .route({ path: "/dashboard-api-keys", method: "GET", tags, summary: "List Dashboard API Keys" })
  .handler(async ({ context }) => {
    return await auth.api.listApiKeys({
      headers: context.request.headers,
    });
  });

const createDashboardApiKey = rootOs
  .meta({ mcp: false })
  .use(withAuth)
  .route({ path: "/dashboard-api-keys", method: "POST", tags, summary: "Create Dashboard API Key" })
  .input(z.object({
    name: z.string().min(3),
    organizationId: z.string().min(1),
  }))
  .handler(async ({ context, input, errors }) => {
    const userId = context.session.user.id;

    const [member] = await getDB().select().from(memberT).where(sql`
      ${memberT.organizationId} = ${input.organizationId}
      AND
      ${memberT.userId} = ${userId}
    `).limit(1);

    if (!member) {
      throw errors.FORBIDDEN({ message: "User is not a member of the organization" });
    }

    try {
      const apiKey = await auth.api.createApiKey({
        headers: context.request.headers,
        query: { greenlitCallId: getGreenlitCallId() },
        body: {
          name: input.name,
          metadata: { organizationId: input.organizationId },
        },
      });
      return { key: apiKey.key, id: apiKey.id };
    } catch (error) {
      log.error(error, "Error during dashboard API key creation");
      throw errors.INTERNAL_SERVER_ERROR({ message: "Failed to create API key" });
    }
  });

const deleteDashboardApiKey = rootOs
  .meta({ mcp: false })
  .use(withAuth)
  .route({ path: "/dashboard-api-keys", method: "DELETE", tags, summary: "Delete Dashboard API Key" })
  .input(z.object({ id: z.string() }))
  .handler(async ({ context, input, errors }) => {
    try {
      await auth.api.deleteApiKey({
        headers: context.request.headers,
        body: { keyId: input.id },
      });
      return { success: true };
    } catch (error) {
      log.error(error, "Error during dashboard API key deletion");
      throw errors.INTERNAL_SERVER_ERROR({ message: "Failed to delete API key" });
    }
  });

export const authRouter = rootOs.prefix("/auth").router({
  changePassword,
  listPasskeys,
  deletePasskey,
  listDashboardApiKeys,
  createDashboardApiKey,
  deleteDashboardApiKey,
});
