/**
 * ORPC procedures for Application management.
 */
import { rootOs, withOrganization, requirePermission } from "../root";
import { z } from "zod";
import { ApplicationDto } from "$lib/orpc/dtos/application.dto";
import { commonInputFilter } from "$lib/orpc/dtos/common.dto";
import { aiApplicationT, aiApiKeyT, sql, isNull, and, eq } from "common-db";
import { pick } from "$lib/util";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "application.procedure" });

const tags = ["Application"];

/** Creates a new Application. */
const createApplication = rootOs
  .use(withOrganization)
  .use(requirePermission({ aiApplication: ["create"] }))
  .route({ path: "/", method: "POST", tags, summary: "Create Application" })
  .input(ApplicationDto.omit({ id: true, organizationId: true, ...commonInputFilter }))
  .handler(async ({ input, context }) => {
    log.info({ name: input.name, org: context.activeOrganizationId }, "Creating new Application");

    const [newApp] = await getDB()
      .insert(aiApplicationT)
      .values({
        ...input,
        organizationId: context.activeOrganizationId,
      })
      .returning();

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
          sql`${aiApplicationT.organizationId} = ${context.activeOrganizationId}`,
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
  .handler(async ({ context, input }) => {
    const [app] = await getDB()
      .select()
      .from(aiApplicationT)
      .where(
        and(
          sql`${aiApplicationT.id} = ${input.id}`,
          sql`${aiApplicationT.organizationId} = ${context.activeOrganizationId}`,
          isNull(aiApplicationT.deletedAt)
        )
      );

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
      .where(
        and(
          sql`${aiApplicationT.id} = ${input.id}`,
          sql`${aiApplicationT.organizationId} = ${context.activeOrganizationId}`,
          isNull(aiApplicationT.deletedAt)
        )
      );
  });

/** Soft deletes an Application (sets deletedAt). */
const softDeleteApplication = rootOs
  .use(withOrganization)
  .use(requirePermission({ aiApplication: ["delete"] }))
  .route({ method: "DELETE", path: "/{id}", tags, summary: "Soft Delete Application" })
  .input(ApplicationDto.pick({ id: true }))
  .handler(async ({ context, input }) => {
    log.info({ id: input.id }, "Soft deleting Application");

    await getDB()
      .update(aiApplicationT)
      .set({ deletedAt: new Date() })
      .where(
        and(
          sql`${aiApplicationT.id} = ${input.id}`,
          sql`${aiApplicationT.organizationId} = ${context.activeOrganizationId}`,
          isNull(aiApplicationT.deletedAt)
        )
      );
  });

export const applicationRouter = rootOs.prefix("/application").router({
  create: createApplication,
  list: listApplications,
  get: getApplication,
  update: updateApplication,
  softDelete: softDeleteApplication,
});
