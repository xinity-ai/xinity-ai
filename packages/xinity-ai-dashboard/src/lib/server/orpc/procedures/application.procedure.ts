/**
 * ORPC procedures for Application management.
 */
import { rootOs, withOrganization, requirePermission } from "../root";
import { ApplicationDto } from "$lib/orpc/dtos/application.dto";
import { commonInputFilter } from "$lib/orpc/dtos/common.dto";
import { aiApplicationT, eq, isNull, and } from "common-db";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";
import { recordAudit } from "$lib/server/audit";

const log = rootLogger.child({ name: "application.procedure" });

const tags = ["Application"];

const matchActiveAppInOrg = (id: string, orgId: string) =>
  and(
    eq(aiApplicationT.id, id),
    eq(aiApplicationT.organizationId, orgId),
    isNull(aiApplicationT.deletedAt),
  );

/** Creates a new Application. */
const createApplication = rootOs
  .use(withOrganization)
  .use(requirePermission({ aiApplication: ["create"] }))
  .route({ path: "/", method: "POST", tags, summary: "Create Application" })
  .input(ApplicationDto.omit({ id: true, organizationId: true, ...commonInputFilter }))
  .handler(async ({ input, context }) => {
    const rlog = log.child({ traceId: context.traceId });
    rlog.info({ name: input.name, org: context.activeOrganizationId }, "Creating new Application");

    const [newApp] = await getDB()
      .insert(aiApplicationT)
      .values({
        ...input,
        organizationId: context.activeOrganizationId,
      })
      .returning();
    if (!newApp) throw new Error("Insert into aiApplicationT returned no row");
    await recordAudit(context, {
      action: "aiApplication.create",
      resourceType: "aiApplication",
      resourceId: newApp.id,
      details: { name: newApp.name },
    });
    return newApp;
  });

/** Lists Applications for the active organization (excluding soft-deleted). */
const listApplications = rootOs
  .use(withOrganization)
  .use(requirePermission({ aiApplication: ["read"] }))
  .route({ path: "/", tags, method: "GET", summary: "List Applications" })
  .handler(async ({ context }): Promise<ApplicationDto[]> => {
    const apps = await getDB()
      .select()
      .from(aiApplicationT)
      .where(
        and(
          eq(aiApplicationT.organizationId, context.activeOrganizationId),
          isNull(aiApplicationT.deletedAt)
        )
      )
      .orderBy(aiApplicationT.createdAt);

    return apps;
  });

/** Gets a single Application by ID. */
const getApplication = rootOs
  .use(withOrganization)
  .use(requirePermission({ aiApplication: ["read"] }))
  .route({ method: "GET", path: "/{id}", tags, summary: "Get Application" })
  .input(ApplicationDto.pick({ id: true }))
  .output(ApplicationDto)
  .errors({ NOT_FOUND: {} })
  .handler(async ({ context, input, errors }) => {
    const [app] = await getDB()
      .select()
      .from(aiApplicationT)
      .where(matchActiveAppInOrg(input.id, context.activeOrganizationId))
      .limit(1);

    if (!app) throw errors.NOT_FOUND();
    return app;
  });

/** Updates an Application name/description. */
const updateApplication = rootOs
  .use(withOrganization)
  .use(requirePermission({ aiApplication: ["update"] }))
  .route({ method: "PATCH", path: "/{id}", tags, summary: "Update Application" })
  .input(ApplicationDto.pick({ id: true, name: true, description: true }))
  .handler(async ({ context, input }) => {
    await getDB()
      .update(aiApplicationT)
      .set({
        name: input.name,
        description: input.description
      })
      .where(matchActiveAppInOrg(input.id, context.activeOrganizationId));
    await recordAudit(context, {
      action: "aiApplication.update",
      resourceType: "aiApplication",
      resourceId: input.id,
      details: { name: input.name },
    });
  });

/** Soft deletes an Application (sets deletedAt). */
const softDeleteApplication = rootOs
  .use(withOrganization)
  .use(requirePermission({ aiApplication: ["delete"] }))
  .route({ method: "DELETE", path: "/{id}", tags, summary: "Soft Delete Application" })
  .input(ApplicationDto.pick({ id: true }))
  .handler(async ({ context, input }) => {
    const rlog = log.child({ traceId: context.traceId });
    rlog.info({ id: input.id }, "Soft deleting Application");

    await getDB()
      .update(aiApplicationT)
      .set({ deletedAt: new Date() })
      .where(matchActiveAppInOrg(input.id, context.activeOrganizationId));
    await recordAudit(context, {
      action: "aiApplication.delete",
      resourceType: "aiApplication",
      resourceId: input.id,
    });
  });

export const applicationRouter = rootOs.prefix("/application").router({
  create: createApplication,
  list: listApplications,
  get: getApplication,
  update: updateApplication,
  softDelete: softDeleteApplication,
});
