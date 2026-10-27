import { rootOs, withOrganization, requirePermission, auditMiddleware } from "../root";
import { inArray, sql, deploymentT, deploymentCanaryT, modelInstallationT, modelInstallationStateT, canaryOfDeployment, installationOfDeployment, stateOfInstallation, type Deployment } from "common-db";
import z from "zod";
import { DeploymentDto, DeploymentInputDto, DeploymentUpdateDto, KvCacheSizeDto, ProgressDto, ReplicasDto, type DeploymentUpdate } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { previewPlacement, syncDeployedModels, type Shortfall, type ShortfallReason } from "$lib/server/lib/deployments/orchestration";
import { requirementsForDeployments, type DeploymentPlan, type ModelRequirementTable } from "$lib/server/lib/deployments/requirements";
import { byType, DASHBOARD_DEPLOYMENT_TYPES } from "$lib/server/lib/deployments/deployment-types";
import { createLegacy, validateCanaryModelTypes } from "$lib/server/lib/deployments/legacy-deployment";
import { deploymentSettingsSchema, FOOTPRINT_PART_MEMORY, type FootprintPart, type FootprintPartKind } from "common-env";
import { resolveSchedulable } from "$lib/server/lib/models/model-catalog";
import { rootLogger } from "$lib/server/logging";
import { findOrgName } from "$lib/server/lib/org-queries";
import { notifyOrgMembers } from "$lib/server/notifications/notification.service";
import { NotificationType } from "$lib/server/notifications/events";
import { config } from "$lib/server/config";
const log = rootLogger.child({ name: "deployment.orpc" });

const tags = ["Deployment"];
const SuccessDto = z.object({ success: z.literal(true) });
const successObject = { success: true } as const;
const PATCHED_TYPES = ["legacy"] as const;

async function assertModelsInCatalog(
  specifiers: string[],
  errors: { BAD_REQUEST: (opts: { message: string }) => Error },
): Promise<void> {
  const statuses = await Promise.all(
    specifiers.map(async (specifier) => ({ specifier, resolution: await resolveSchedulable(specifier, null) })),
  );
  const missing = statuses.find((s) => s.resolution.status === "not_found");
  if (missing) {
    throw errors.BAD_REQUEST({ message: `Model "${missing.specifier}" was not found in the model catalog` });
  }
}

export const LegacyDraftDto = z.object({
  specifier: z.string().trim(),
  earlySpecifier: z.string().trim().nullish(),
  replicas: ReplicasDto.default(1),
  progress: ProgressDto.default(100),
  kvCacheSize: KvCacheSizeDto.nullish(),
  earlyKvCacheSize: KvCacheSizeDto.nullish(),
  preferredDriver: z.enum(["ollama", "vllm"]).nullish(),
  settings: deploymentSettingsSchema.optional(),
});

const CapacityCheckInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("legacy"),
    deploymentId: z.uuid().optional().describe("The deployment this draft changes, which is planned without its own installations"),
    legacy: LegacyDraftDto,
  }),
]);

const FootprintPartDto = z.object({
  part: z.enum(Object.keys(FOOTPRINT_PART_MEMORY) as [FootprintPartKind, ...FootprintPartKind[]]),
  memory: z.enum(["gpu", "host"]),
  gb: z.number(),
});

const withMemory = (parts: FootprintPart[]) => parts.map(({ part, gb }) => ({ part, memory: FOOTPRINT_PART_MEMORY[part], gb }));

const PlannedMachineDto = z.object({
  machineName: z.string().describe("Name of the machine"),
  cards: z.number().describe("Cards the replica would use on this machine"),
  gpuGb: z.number().describe("GPU memory in GB the replica would occupy on this machine, over all its cards"),
  hostGb: z.number().describe("Host memory in GB the replica would occupy on this machine"),
  sharedMemory: z.boolean().describe("Whether host and GPU memory are one pool on this machine, so host parts count against its free memory"),
  parts: z.array(FootprintPartDto).describe("What the replica's memory on this machine consists of"),
});

const PlannedReplicaDto = z.object({
  specifier: z.string(),
  machines: z.array(PlannedMachineDto).describe("The machines the replica would run on, the one serving it first"),
});

const CapacityShortfallDto = z.object({
  specifier: z.string(),
  machines: z.number().describe("Machines one replica spans"),
  perMachine: z.array(z.object({
    machineName: z.string(),
    neededGb: z.number().describe("Memory in GB the replica would take on this machine, charged as this machine counts memory"),
    freeGb: z.number().describe("Memory in GB free on this machine now"),
    sharedMemory: z.boolean().describe("Whether host and GPU memory are one pool on this machine, so host parts count against its free memory"),
    parts: z.array(FootprintPartDto).describe("What the needed memory on this machine consists of"),
  })).describe("Each machine that could run the model, the one closest to fitting first"),
});

export const CapacityCheckOutput = z.object({
  deployable: z.boolean(),
  reason: z.string().optional(),
  replicas: z.array(PlannedReplicaDto).describe("Where each replica would be placed now, as the scheduler would place it"),
  shortfall: CapacityShortfallDto.optional().describe("What a model that does not fit needs, against what is free"),
});

export type CapacityCheckResult = z.infer<typeof CapacityCheckOutput>;
export type CapacityShortfall = z.infer<typeof CapacityShortfallDto>;
export type PlannedReplicaPreview = z.infer<typeof PlannedReplicaDto>;

const SHORTFALL_REASONS: Record<ShortfallReason, (shortfall: Shortfall) => string> = {
  catalog_unavailable: () => "Capacity could not be verified: model catalog is unavailable",
  not_found: ({ specifier }) => `Model "${specifier}" was not found in the model catalog`,
  no_compatible_node: ({ specifier, constraints }) => {
    const versionRequirement = constraints?.minVersion ? ` >= ${constraints.minVersion}` : "";
    const platforms = constraints?.requiredPlatforms ?? [];
    const platformRequirement = platforms.length ? `, platform: ${platforms.join("/")}` : "";
    return `No compatible node for "${specifier}" (requires ${constraints?.driver}${versionRequirement}${platformRequirement})`;
  },
  no_capacity: ({ specifier, need }) => need
    ? `"${specifier}" does not fit in the free memory`
    : `"${specifier}" needs more capacity than is currently available`,
  license_limit: ({ specifier }) => `"${specifier}" would exceed the VRAM your license allows`,
};

const DRAFT_DEPLOYMENT_ID = "draft";

function draftPlan(draft: z.infer<typeof LegacyDraftDto>, id = DRAFT_DEPLOYMENT_ID): DeploymentPlan {
  return {
    id,
    specifier: draft.specifier,
    earlySpecifier: draft.earlySpecifier ?? null,
    replicas: draft.replicas,
    progress: draft.progress,
    kvCacheSize: draft.kvCacheSize ?? null,
    earlyKvCacheSize: draft.earlyKvCacheSize ?? null,
    preferredDriver: draft.preferredDriver ?? null,
    settings: draft.settings ?? { version: 1 },
    canaryProgressFrom: null,
    canaryProgressUntil: null,
  };
}

// A deployment being changed is planned without its own installations, which the change replaces.
async function checkDeploymentCapacity(requirements: ModelRequirementTable, replacedOwnerIds: string[] = []): Promise<CapacityCheckResult> {
  const { replicas, shortfalls } = await previewPlacement(requirements, replacedOwnerIds);
  const blocking = shortfalls.find((shortfall) => shortfall.reason !== "catalog_unavailable");
  const shortfall = blocking ?? shortfalls[0];
  return {
    deployable: !blocking,
    reason: shortfall && SHORTFALL_REASONS[shortfall.reason](shortfall),
    replicas: replicas.map((replica) => ({
      ...replica,
      machines: replica.machines.map((machine) => ({ ...machine, parts: withMemory(machine.parts) })),
    })),
    shortfall: shortfall?.need && {
      specifier: shortfall.specifier,
      machines: shortfall.need.machines,
      perMachine: shortfall.need.perMachine.map(({ machine, parts, ...rest }) => ({
        machineName: machine,
        ...rest,
        parts: withMemory(parts),
      })),
    },
  };
}

const matchActiveDeploymentInOrg = (id: string, orgId: string) =>
  sql`${deploymentT.id} = ${id}
    AND ${deploymentT.organizationId} = ${orgId}
    AND ${deploymentT.deletedAt} IS NULL`;

async function internalUpdateDeployment(orgId: string, id: string, params: Partial<Deployment>): Promise<Deployment | undefined> {
  const [deployment] = await getDB().update(deploymentT)
    .set(params)
    .where(matchActiveDeploymentInOrg(id, orgId))
    .returning();
  return deployment;
}

async function findActiveDeploymentInOrg(id: string, orgId: string): Promise<Deployment | undefined> {
  const [deployment] = await getDB().select().from(deploymentT)
    .where(matchActiveDeploymentInOrg(id, orgId))
    .limit(1);
  return deployment;
}

async function readDeployment(entry: Deployment) {
  const [deployment] = await DASHBOARD_DEPLOYMENT_TYPES[entry.type].read([entry]);
  return deployment;
}

function sharedFieldsOf({ name, description, enabled, publicSpecifier }: DeploymentUpdate) {
  return { name, description, enabled, publicSpecifier };
}

const listDeployments = rootOs.use(withOrganization)
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route({ path: "/", method: "GET", tags, summary: "List Deployments", description: "Lists deployments accessible to the current user" })
  .input(z.object({ withStatus: z.coerce.boolean().default(false) }))
  .output(DeploymentDto.array())
  .handler(async ({ context, input }) => {
    const entries = await getDB().select().from(deploymentT).where(sql`
      ${deploymentT.organizationId} = ${context.activeOrganizationId}
      AND ${deploymentT.deletedAt} IS NULL
    `);
    const deployments = await byType(entries, (type, ofType) => input?.withStatus ? type.withStatus(ofType) : type.read(ofType));
    return deployments.flat();
  });
/** Updates a deployment and triggers a sync. */
const updateDeployment = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["update"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "modelDeployment.update", resource: "modelDeployment", resourceId: { fromInput: "id" } } })
  .route({
    path: "/{id}", method: "PATCH", tags, summary: "Update Deployment",
  })
  .input(DeploymentUpdateDto)
  .output(DeploymentDto)
  .errors({ NOT_FOUND: {}, BAD_REQUEST: {}, INSUFFICIENT_CAPACITY: {}, CONFLICT: {} })
  .handler(async ({ context, input, errors }) => {
    const rlog = log.child({ traceId: context.traceId });
    const current = await findActiveDeploymentInOrg(input.id, context.activeOrganizationId);
    if (!current) throw errors.NOT_FOUND();
    const foreign = PATCHED_TYPES.find((other) => other !== current.type && input[other] !== undefined);
    if (foreign) {
      throw errors.BAD_REQUEST({ message: `This deployment is of type ${current.type}, so it has no ${foreign} part to change` });
    }
    const type = DASHBOARD_DEPLOYMENT_TYPES[current.type];

    const review = await type.reviewUpdate(current, input);
    if ("rejected" in review) {
      throw errors.BAD_REQUEST({ message: review.rejected });
    }
    if (review.mustFit) {
      const result = await checkDeploymentCapacity(review.mustFit.requirements, review.mustFit.replacing);
      if (!result.deployable) {
        throw errors.INSUFFICIENT_CAPACITY({ message: result.reason });
      }
    }

    const updated = await getDB().transaction(async (tx) => {
      const [entry] = await tx.update(deploymentT)
        .set({ ...sharedFieldsOf(input), updatedAt: new Date() })
        .where(matchActiveDeploymentInOrg(input.id, context.activeOrganizationId))
        .returning();
      if (entry) {
        await type.update(tx, entry, input);
      }
      return entry;
    }).catch((err: unknown) => {
      rlog.error(err);
      throw errors.CONFLICT({ message: "A deployment with this specifier already exists in your organization" });
    });
    const deployment = updated && await readDeployment(updated);
    if (!deployment) {
      throw errors.NOT_FOUND();
    }
    syncDeployedModels();
    return deployment;
  });

export const toggleEnabled = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["update"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "modelDeployment.toggle_enabled", resource: "modelDeployment", resourceId: { fromInput: "id" }, captureInput: ["enabled"] } })
  .route({
    path: "/{id}/toggle-enabled", method: "PATCH", tags, summary: "Toggle Deployment Enabled State",
    description: "Updates the deployment, specifically by setting it enabled or disabled",
  })
  .input(z.object({ id: z.uuid(), enabled: z.boolean() }))
  .output(SuccessDto)
  .errors({ NOT_FOUND: {}, INSUFFICIENT_CAPACITY: {} })
  .handler(async ({ context, input, errors }) => {
    if (input.enabled) {
      const current = await findActiveDeploymentInOrg(input.id, context.activeOrganizationId);
      if (!current) throw errors.NOT_FOUND();
      if (!current.enabled) {
        const result = await checkDeploymentCapacity(await DASHBOARD_DEPLOYMENT_TYPES[current.type].requirements([current]));
        if (!result.deployable) {
          throw errors.INSUFFICIENT_CAPACITY({ message: result.reason });
        }
      }
    }
    const deployment = await internalUpdateDeployment(context.activeOrganizationId, input.id, { enabled: input.enabled });
    if (!deployment) {
      throw errors.NOT_FOUND();
    }
    syncDeployedModels();
    return successObject;
  });
const getDeployment = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route({
    summary: "Get Deployment",
    path: "/{id}", method: "GET", tags, description: `Endpoint to get a deployment by id.
    Unlike other deployment related endpoints, this one also returns computed properties such as those
    relevant for canary deployments, and exact deployment transition state`,
  })
  .input(z.object({ id: z.uuid(), withStatus: z.coerce.boolean().default(false) }))
  .output(DeploymentDto)
  .errors({ NOT_FOUND: {} })
  .handler(async ({ context, input, errors }) => {
    const entry = await findActiveDeploymentInOrg(input.id, context.activeOrganizationId);
    if (!entry) throw errors.NOT_FOUND();
    const [deployment] = input.withStatus
      ? await DASHBOARD_DEPLOYMENT_TYPES[entry.type].withStatus([entry])
      : [await readDeployment(entry)];
    if (!deployment) throw errors.NOT_FOUND();
    return deployment;
  });
export const deleteDeployment = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["delete"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "modelDeployment.delete", resource: "modelDeployment", resourceId: { fromInput: "id" } } })
  .route({
    summary: "Delete Deployment",
    path: "/{id}", method: "DELETE", tags, description: `Endpoint to delete a deployment completely.
Immediately unregisters it, and drops it completely.
**Consider disabling it instead.**`
  })
  .input(z.object({ id: z.uuid() }))
  .errors({ NOT_FOUND: {} })
  .handler(async ({ context, input, errors }) => {
    const deployment = await internalUpdateDeployment(context.activeOrganizationId, input.id, { deletedAt: new Date() });
    if (!deployment) {
      throw errors.NOT_FOUND();
    }
    syncDeployedModels();
    return { success: true };
  });
export const retryDeployment = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["update"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "modelDeployment.retry", resource: "modelDeployment", resourceId: { fromInput: "id" } } })
  .route({
    path: "/{id}/retry", method: "POST", tags, summary: "Retry Failed Installations",
  })
  .input(z.object({ id: z.uuid() }))
  .output(SuccessDto)
  .errors({ NOT_FOUND: {} })
  .handler(async ({ context, input, errors }) => {
    const deployment = await findActiveDeploymentInOrg(input.id, context.activeOrganizationId);
    if (!deployment) throw errors.NOT_FOUND();

    const failed = await getDB()
      .select({ id: modelInstallationT.id, group: modelInstallationT.group })
      .from(deploymentT)
      .leftJoin(deploymentCanaryT, canaryOfDeployment)
      .innerJoin(modelInstallationT, installationOfDeployment)
      .innerJoin(modelInstallationStateT, sql`
        ${stateOfInstallation}
        AND ${modelInstallationStateT.lifecycleState} = ${"failed"}
      `)
      .where(sql`${deploymentT.id} = ${deployment.id} AND ${modelInstallationT.deletedAt} IS NULL`);

    // A daemon keeps a failure it has seen and a group keeps its spent restarts, so fresh installations
    // replace the failed ones, a group as a whole, instead of their states being cleared.
    if (failed.length > 0) {
      const groupIds = [...new Set(failed.flatMap(({ group }) => (group ? [group.id] : [])))];
      const failedGroups = groupIds.length > 0 ? sql` OR ${inArray(sql`${modelInstallationT.group}->>'id'`, groupIds)}` : sql``;
      await getDB()
        .update(modelInstallationT)
        .set({ deletedAt: new Date() })
        .where(sql`${modelInstallationT.deletedAt} IS NULL AND (${inArray(modelInstallationT.id, failed.map(({ id }) => id))}${failedGroups})`);
    }

    syncDeployedModels();
    return successObject;
  });

const findDeployment = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route({
    summary: "Get Deployment by spec",
    path: "/find/", method: "GET", tags, description: "Endpoint to find deployments via the specifier (public)",
  })
  .input(z.object({ publicSpecifier: z.string().trim() }))
  .output(DeploymentDto)
  .errors({ NOT_FOUND: {} })
  .handler(async ({ context, input, errors }) => {
    const [entry] = await getDB().select().from(deploymentT)
      .where(sql`
        ${deploymentT.publicSpecifier} = ${input.publicSpecifier}
        AND ${deploymentT.organizationId} = ${context.activeOrganizationId}
        AND ${deploymentT.deletedAt} IS NULL
      `)
      .limit(1);
    const deployment = entry && await readDeployment(entry);
    if (!deployment) {
      throw errors.NOT_FOUND();
    }
    return deployment;
  });
export const createDeployment = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["create"] }))
  .use(auditMiddleware)
  .meta({ audit: { action: "modelDeployment.create", resource: "modelDeployment", resourceId: { fromOutput: "id" }, captureInput: ["name", "type", "legacy"] } })
  .route({
    summary: "Create Deployment",
    path: "/", method: "POST", tags, description: `Endpoint to create new deployments`
  })
  .input(DeploymentInputDto)
  .output(DeploymentDto)
  .errors({ CONFLICT: {}, BAD_REQUEST: {}, INSUFFICIENT_CAPACITY: {} })
  .handler(async ({ context, input, errors }) => {
    if (!input.legacy.specifier) {
      throw errors.BAD_REQUEST({ message: "specifier is required when creating a deployment" });
    }
    const primarySpecifier = input.legacy.specifier;
    const earlySpecifier = input.legacy.earlySpecifier ?? null;

    await assertModelsInCatalog(
      [primarySpecifier, ...(earlySpecifier ? [earlySpecifier] : [])],
      errors,
    );

    const rlog = log.child({ traceId: context.traceId });
    const mismatch = await validateCanaryModelTypes(primarySpecifier, earlySpecifier);
    if (mismatch) throw errors.BAD_REQUEST({ message: mismatch });

    if (input.enabled) {
      const result = await checkDeploymentCapacity(requirementsForDeployments([draftPlan(input.legacy)]));
      if (!result.deployable) {
        throw errors.INSUFFICIENT_CAPACITY({ message: result.reason });
      }
    }

    try {
      const entry = await getDB().transaction(async (tx) => {
        const legacyId = await createLegacy(tx, { ...input.legacy, earlySpecifier });
        const [entry] = await tx
          .insert(deploymentT)
          .values({
            name: input.name,
            description: input.description,
            enabled: input.enabled,
            publicSpecifier: input.publicSpecifier,
            type: input.type,
            legacyId,
            organizationId: context.activeOrganizationId,
          })
          .returning();
        return entry;
      });
      const deployment = entry && await readDeployment(entry);
      if (!deployment) throw new Error("Insert into deploymentT returned no row");
      void syncDeployedModels();
      const orgName = await findOrgName(context.activeOrganizationId);
      void notifyOrgMembers({
        type: NotificationType.deployment_created,
        organizationId: context.activeOrganizationId,
        data: {
          deploymentName: deployment.name,
          publicSpecifier: deployment.publicSpecifier,
          creatorName: context.session.user.name || context.session.user.email,
          orgName: orgName ?? "",
          dashboardUrl: `${config.origin}/modelhub/`,
        },
      }).catch((err: unknown) => rlog.error({ err }, "Failed to send deployment created notification"));
      return deployment;
    } catch (err) {
      rlog.error(err);
      throw errors.CONFLICT({ message: "A deployment with this specifier already exists in your organization" })
    }
  });

const checkCapacity = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route({
    path: "/check-capacity", method: "POST", tags,
    summary: "Check Deployment Capacity",
    description: "Checks whether the cluster has enough free capacity to host a deployment with the given configuration",
  })
  .input(CapacityCheckInput)
  .output(CapacityCheckOutput)
  .handler(async ({ context, input }): Promise<CapacityCheckResult> =>  {
    const replaced = input.deploymentId ? await findActiveDeploymentInOrg(input.deploymentId, context.activeOrganizationId) : undefined;
    const replacedId = replaced?.legacyId ?? undefined;
    return checkDeploymentCapacity(requirementsForDeployments([draftPlan(input.legacy, replacedId)]), replacedId ? [replacedId] : []);
  });

export const deploymentsRouter = rootOs.prefix("/deployments").router({
  create: createDeployment,
  get: getDeployment,
  update: updateDeployment,
  delete: deleteDeployment,
  list: listDeployments,
  find: findDeployment,
  enable: toggleEnabled,
  retry: retryDeployment,
  checkCapacity,
});
