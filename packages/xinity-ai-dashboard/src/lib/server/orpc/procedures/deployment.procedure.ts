import { rootOs, withOrganization, requirePermission } from "../root";
import { commonInputFilter } from "$lib/orpc/dtos/common.dto";
import { sql, modelDeploymentT, modelInstallationT, modelInstallationStateT, organizationT, type ModelDeployment } from "common-db";
import z from "zod";
import { DeploymentDto } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { syncDeployedModels } from "$lib/server/lib/orchestration.mod";
import { infoClient } from "$lib/server/info-client";
import { buildClusterCapacity } from "./cluster.procedure";
import { resolveDriverForProviderModel, resolveMinVersionForDriver, resolveRequiredPlatformsForDriver, checkNodeCompatibility, type ModelNodeRequirements } from "xinity-infoserver";
import { rootLogger } from "$lib/server/logging";
import { aggregatePhase, type PhaseInfo } from "$lib/server/lib/deployment-phase";
import { notifyOrgMembers } from "$lib/server/notifications/notification.service";
import { NotificationType } from "$lib/server/notifications/events";
import { serverEnv } from "$lib/server/serverenv";
const log = rootLogger.child({ name: "deployment.orpc" });

const tags = ["Deployment"];
const SuccessDto = z.object({ success: z.literal(true) });
const successObject = { success: true } as const;

/** Validates that primary and canary models share the same type. */
async function validateCanaryModelTypes(modelSpecifier: string, earlyModelSpecifier: string | null | undefined) {
  if (!earlyModelSpecifier) return;
  const primary = await infoClient?.fetchModel(modelSpecifier);
  const canary = await infoClient?.fetchModel(earlyModelSpecifier);
  if (primary?.type && canary?.type && primary.type !== canary.type) {
    throw new Error(`Cannot mix model types in a canary deployment: primary is "${primary.type}" but canary is "${canary.type}"`);
  }
}

/** Input shape for capacity checking, matches the deployment fields that affect capacity. */
const CapacityCheckInput = z.object({
  modelSpecifier: z.string().trim(),
  earlyModelSpecifier: z.string().trim().nullish(),
  replicas: z.number().default(1),
  progress: z.number().default(100),
  kvCacheSize: z.number().nullish(),
  earlyKvCacheSize: z.number().nullish(),
});

const CapacityCheckOutput = z.object({
  deployable: z.boolean(),
  reason: z.string().optional(),
});

type CapacityCheckResult = z.infer<typeof CapacityCheckOutput>;

/**
 * Checks whether the cluster has enough free capacity to host a deployment configuration.
 * For canary deployments, validates that both primary and canary models can be placed,
 * accounting for the fact that they share the same pool of node capacity.
 */
async function checkDeploymentCapacity(input: z.infer<typeof CapacityCheckInput>): Promise<CapacityCheckResult> {
  const isCanary = input.progress < 100 && !!input.earlyModelSpecifier;

  // Build the list of models that need capacity
  const modelsToCheck: { specifier: string; replicas: number; kvCacheSize: number | null | undefined }[] = [];
  if (isCanary) {
    modelsToCheck.push(
      { specifier: input.modelSpecifier, replicas: Math.ceil(input.replicas * (input.progress / 100)), kvCacheSize: input.kvCacheSize },
      { specifier: input.earlyModelSpecifier!, replicas: Math.ceil(input.replicas * ((100 - input.progress) / 100)), kvCacheSize: input.earlyKvCacheSize ?? input.kvCacheSize },
    );
  } else {
    modelsToCheck.push({ specifier: input.modelSpecifier, replicas: input.replicas, kvCacheSize: input.kvCacheSize });
  }

  // Fetch model info for all models, distinguishing not_found from unavailable
  const modelInfos = await Promise.all(
    modelsToCheck.map(async (m) => {
      const status = await infoClient?.fetchModelStatus(m.specifier);
      if (!status || status.status === "unavailable") return { kind: "unavailable" as const, specifier: m.specifier };
      if (status.status === "not_found") return { kind: "not_found" as const, specifier: m.specifier };
      const info = status.model;
      const effectiveKvCache = Math.max(m.kvCacheSize ?? 0, info.minKvCache);
      const driver = resolveDriverForProviderModel(info, m.specifier);
      const minVersion = driver ? resolveMinVersionForDriver(info, driver) : undefined;
      const requiredPlatforms = driver ? resolveRequiredPlatformsForDriver(info, driver) : [];
      return { kind: "found" as const, specifier: m.specifier, replicas: m.replicas, perReplica: info.weight + effectiveKvCache, driver, minVersion, requiredPlatforms };
    }),
  );

  const notFound = modelInfos.find(m => m.kind === "not_found");
  if (notFound) return { deployable: false, reason: `Model "${notFound.specifier}" was not found in the model catalog` };

  const resolved = modelInfos.filter((m): m is Extract<typeof modelInfos[number], { kind: "found" }> => m.kind === "found");
  if (resolved.length === 0) return { deployable: true, reason: "Capacity could not be verified: model catalog is unavailable" };

  const { nodeCapabilities } = await buildClusterCapacity();
  const remaining = nodeCapabilities
    .map(n => ({ ...n }))
    .sort((a, b) => b.free - a.free);

  for (const model of resolved) {
    // Filter nodes that are structurally compatible (driver, version, platform) - capacity checked in allocation loop
    const compatible = model.driver
      ? remaining.filter(n => {
          const req: ModelNodeRequirements = {
            driver: model.driver!, capacityGb: 0,
            minVersion: model.minVersion, requiredPlatforms: model.requiredPlatforms,
          };
          const reason = checkNodeCompatibility(n, req);
          return reason === null || reason === "insufficient_capacity";
        })
      : remaining;

    let placed = 0;
    for (const node of compatible) {
      if (placed >= model.replicas) break;
      if (node.free >= model.perReplica) {
        node.free -= model.perReplica;
        placed++;
      }
    }
    if (placed < model.replicas) {
      const reason = compatible.length === 0 && model.driver
        ? `No compatible node for "${model.specifier}" (requires ${model.driver}${model.minVersion ? ` >= ${model.minVersion}` : ""}${model.requiredPlatforms.length ? `, platform: ${model.requiredPlatforms.join("/")}` : ""})`
        : `Insufficient cluster capacity: cannot place ${model.replicas} ${model.replicas === 1 ? "replica" : "replicas"} of "${model.specifier}" (${model.perReplica.toFixed(1)} GB each). Only ${placed} compatible ${placed === 1 ? "node has" : "nodes have"} enough free capacity`;
      return { deployable: false, reason };
    }
  }
  return { deployable: true };
}

async function internalUpdateDeployment(orgId: string, id: string, params: Partial<ModelDeployment>): Promise<ModelDeployment | undefined> {
  const [deployment] = await getDB().update(modelDeploymentT)
    .set(params)
    .where(sql`
      ${modelDeploymentT.id} = ${id}
      AND
      ${modelDeploymentT.organizationId} = ${orgId}
      AND
      ${modelDeploymentT.deletedAt} IS NULL`)
    .returning();
  return deployment;
}

// ---------------------------------------------------------------------------
// Shared status schema and query helper
// ---------------------------------------------------------------------------

const DeploymentStatusSchema = z.object({
  phase: z.enum(["ready", "downloading", "installing", "failed", "scheduling", "not_in_catalog"]),
  progress: z.number().nullable(),
  error: z.string().nullable().optional(),
  failureLogs: z.string().nullable().optional(),
});

export const DeploymentWithStatusDto = DeploymentDto.extend({ status: DeploymentStatusSchema.optional() });
export type DeploymentWithStatus = z.infer<typeof DeploymentWithStatusDto>;
type StatusPhase = "ready" | "downloading" | "installing" | "failed" | "scheduling" | "not_in_catalog";

/**
 * Runs the status join query and aggregates installation phase info for the given deployments.
 * `where` should narrow to the specific deployment rows you want (org condition + optional id filter).
 */
async function queryDeploymentsWithStatus(where: ReturnType<typeof sql>): Promise<DeploymentWithStatus[]> {
  const rows = await getDB()
    .select()
    .from(modelDeploymentT)
    .leftJoin(modelInstallationT, sql`
      (${modelDeploymentT.modelSpecifier} = ${modelInstallationT.model}
      OR
      ${modelDeploymentT.earlyModelSpecifier} = ${modelInstallationT.model})
      AND ${modelInstallationT.deletedAt} IS NULL`)
    .leftJoin(modelInstallationStateT, sql`${modelInstallationStateT.id} = ${modelInstallationT.id}`)
    .where(where);

  const deploymentMap = new Map<string, { deployment: ModelDeployment; phaseInfo?: PhaseInfo }>();

  for (const row of rows) {
    const deployment = row.model_deployment;
    let entry = deploymentMap.get(deployment.id);
    if (!entry) {
      entry = { deployment };
      deploymentMap.set(deployment.id, entry);
    }

    const installation = row.model_installation;
    const state = row.model_installation_state;

    if (installation && !state) {
      entry.phaseInfo = aggregatePhase(entry.phaseInfo, "scheduling", null, null);
      continue;
    }
    if (!state) continue;

    const phase = state.lifecycleState;
    const progress = (phase === "downloading" || phase === "installing") ? (state.progress ?? null) : null;
    entry.phaseInfo = aggregatePhase(entry.phaseInfo, phase, progress, state.errorMessage, state.failureLogs);
  }

  return Array.from(deploymentMap.values()).map(({ deployment, phaseInfo }) => {
    const status = phaseInfo
      ? { phase: phaseInfo.phase as StatusPhase, progress: phaseInfo.progress, error: phaseInfo.error, failureLogs: phaseInfo.failureLogs }
      : undefined;
    return status ? { ...deployment, status } : deployment;
  });
}

const listDeployments = rootOs.use(withOrganization)
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route({ path: "/", method: "GET", tags, summary: "List Deployments", description: "Lists deployments accessible to the current user" })
  .input(z.object({ withStatus: z.coerce.boolean().default(false) }))
  .output(DeploymentWithStatusDto.array())
  .handler(async ({ context, input }) => {
    const orgCondition = sql`${modelDeploymentT.organizationId} = ${context.activeOrganizationId} AND ${modelDeploymentT.deletedAt} IS NULL`;
    if (input?.withStatus) {
      const results = await queryDeploymentsWithStatus(orgCondition);

      // For enabled deployments with no installations at all, check whether the
      // model still exists in the catalog. If it has been removed, surface that
      // as a distinct "not_in_catalog" phase so the UI can warn the operator.
      const noStatusEnabled = results.filter(r => !r.status && r.enabled);
      if (noStatusEnabled.length > 0 && infoClient) {
        const specifiers = [...new Set(
          noStatusEnabled.flatMap(e => [
            e.modelSpecifier,
            ...(e.earlyModelSpecifier ? [e.earlyModelSpecifier] : []),
          ]),
        )];
        try {
          const batchResult = await infoClient.fetchModelsBatch(specifiers);
          for (const entry of noStatusEnabled) {
            const primaryMissing = batchResult[entry.modelSpecifier] === null;
            const earlyMissing = entry.earlyModelSpecifier
              ? batchResult[entry.earlyModelSpecifier] === null
              : false;
            if (primaryMissing || earlyMissing) {
              (entry as any).status = { phase: "not_in_catalog" as const, progress: null, error: null };
            }
          }
        } catch {
          // Info server unreachable: leave status as undefined rather than
          // falsely marking deployments as not_in_catalog.
        }
      }

      return results;
    }
    return await getDB().select().from(modelDeploymentT).where(orgCondition);
  });
/** Updates a deployment and triggers a sync. */
const updateDeployment = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["update"] }))
  .route({
    path: "/{id}", method: "PATCH", tags, summary: "Update Deployment",
  })
  .input(DeploymentDto.omit(commonInputFilter))
  .output(DeploymentDto)
  .errors({ NOT_FOUND: {}, BAD_REQUEST: {}, INSUFFICIENT_CAPACITY: {}, CONFLICT: {} })
  .handler(async ({ context, input, errors }) => {
    const rlog = log.child({ traceId: context.traceId });
    if (input.modelSpecifier && input.earlyModelSpecifier) {
      try {
        await validateCanaryModelTypes(input.modelSpecifier, input.earlyModelSpecifier);
      } catch (err: unknown) {
        throw errors.BAD_REQUEST({ message: err instanceof Error ? err.message : String(err) });
      }
    }

    // Fetch current state for validation
    const [current] = await getDB().select().from(modelDeploymentT)
      .where(sql`
        ${modelDeploymentT.id} = ${input.id}
      AND
        ${modelDeploymentT.organizationId} = ${context.activeOrganizationId}
      AND
        ${modelDeploymentT.deletedAt} IS NULL
      `).limit(1);
    if (!current) throw errors.NOT_FOUND();

    // When the deployment is enabled and not being disabled, block changes to restricted fields
    const staysEnabled = current.enabled && input.enabled !== false;
    if (staysEnabled) {
      const restricted: { field: string; changed: boolean }[] = [
        { field: "kvCacheSize", changed: input.kvCacheSize !== undefined && input.kvCacheSize !== current.kvCacheSize },
        { field: "earlyKvCacheSize", changed: input.earlyKvCacheSize !== undefined && input.earlyKvCacheSize !== current.earlyKvCacheSize },
        { field: "preferredDriver", changed: input.preferredDriver !== undefined && input.preferredDriver !== current.preferredDriver },
        { field: "modelSpecifier", changed: input.modelSpecifier !== undefined && input.modelSpecifier !== current.modelSpecifier },
        { field: "earlyModelSpecifier", changed: input.earlyModelSpecifier !== undefined && input.earlyModelSpecifier !== current.earlyModelSpecifier },
      ];
      const changed = restricted.filter(r => r.changed).map(r => r.field);
      if (changed.length > 0) {
        throw errors.BAD_REQUEST({
          message: `Cannot change ${changed.join(", ")} while the deployment is enabled. Disable it first.`,
        });
      }
    }

    // Check capacity when re-enabling a disabled deployment
    if (input.enabled && !current.enabled) {
      const merged = { ...current, ...input };
      const result = await checkDeploymentCapacity(merged);
      if (!result.deployable) {
        throw errors.INSUFFICIENT_CAPACITY({ message: result.reason });
      }
    }

    let deployment;
    try {
      deployment = await internalUpdateDeployment(context.activeOrganizationId, input.id, input);
    } catch (err) {
      rlog.error(err);
      throw errors.CONFLICT({ message: "A deployment with this specifier already exists in your organization" });
    }
    if (!deployment) {
      throw errors.NOT_FOUND();
    }
    syncDeployedModels();
    return deployment;
  });

const toggleEnabled = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["update"] }))
  .route({
    path: "/{id}", method: "PATCH", tags, summary: "Toggle Deployment Enabled State",
    description: "Updates the deployment, specifically by setting it enabled or disabled",
  })
  .input(DeploymentDto.pick({ id: true, enabled: true }))
  .output(SuccessDto)
  .errors({ NOT_FOUND: {}, INSUFFICIENT_CAPACITY: {} })
  .handler(async ({ context, input, errors }) => {
    if (input.enabled) {
      // Fetch current state to check if we're re-enabling a disabled deployment
      const [current] = await getDB().select().from(modelDeploymentT)
        .where(sql`
          ${modelDeploymentT.id} = ${input.id}
        AND
          ${modelDeploymentT.organizationId} = ${context.activeOrganizationId}
        AND
          ${modelDeploymentT.deletedAt} IS NULL
        `).limit(1);
      if (!current) throw errors.NOT_FOUND();
      if (!current.enabled) {
        const result = await checkDeploymentCapacity(current);
        if (!result.deployable) {
          throw errors.INSUFFICIENT_CAPACITY({ message: result.reason });
        }
      }
    }
    const deployment = await internalUpdateDeployment(context.activeOrganizationId, input.id, input);
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
  .output(DeploymentWithStatusDto)
  .errors({ NOT_FOUND: {} })
  .handler(async ({ context, input, errors }) => {
    const condition = sql`
      ${modelDeploymentT.id} = ${input.id}
      AND ${modelDeploymentT.organizationId} = ${context.activeOrganizationId}
      AND ${modelDeploymentT.deletedAt} IS NULL`;

    if (input.withStatus) {
      const results = await queryDeploymentsWithStatus(condition);
      if (results.length === 0) throw errors.NOT_FOUND();
      return results[0];
    }

    const [deployment] = await getDB().select().from(modelDeploymentT).where(condition).limit(1);
    if (!deployment) throw errors.NOT_FOUND();
    return deployment;
  });
const deleteDeployment = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["delete"] }))
  .route({
    summary: "Delete Deployment",
    path: "/{id}", method: "DELETE", tags, description: `Endpoint to delete a deployment completely.
Immediately unregisters it, and drops it completely.
**Consider disabling it instead.**`
  })
  .input(z.object({ id: z.uuid() }))
  .errors({ NOT_FOUND: {} })
  .handler(async ({ context, input, errors }) => {
    const [deployment] = await getDB().update(modelDeploymentT)
      .set({ deletedAt: new Date() })
      .where(sql`
        ${modelDeploymentT.id} = ${input.id}
      AND
        ${modelDeploymentT.organizationId} = ${context.activeOrganizationId}
      AND
        ${modelDeploymentT.deletedAt} IS NULL
      `)
      .returning();
    if (!deployment) {
      throw errors.NOT_FOUND();
    }
    syncDeployedModels();
    return { success: true };
  });
const findDeployment = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route({
    summary: "Get Deployment by spec",
    path: "/find/", method: "GET", tags, description: "Endpoint to find deployments via the specifier (public)",
  })
  .input(DeploymentDto.pick({ publicSpecifier: true }))
  .output(DeploymentDto)
  .errors({ NOT_FOUND: {} })
  .handler(async ({ context, input, errors }) => {
    const [deployment] = await getDB().select().from(modelDeploymentT)
      .where(sql`
      ${modelDeploymentT.publicSpecifier} = ${input.publicSpecifier}
      AND
        ${modelDeploymentT.organizationId} = ${context.activeOrganizationId}
      AND
        ${modelDeploymentT.deletedAt} IS NULL
      `).limit(1);
    if (!deployment) {
      throw errors.NOT_FOUND();
    }
    return deployment as z.infer<typeof DeploymentDto>;
  });
export const createDeployment = rootOs
  .use(withOrganization)
  .use(requirePermission({ modelDeployment: ["create"] }))
  .route({
    summary: "Create Deployment",
    path: "/", method: "POST", tags, description: `Endpoint to create new deployments`
  })
  .input(DeploymentDto.omit({ ...commonInputFilter, id: true }))
  .output(DeploymentDto)
  .errors({ CONFLICT: {}, BAD_REQUEST: {} })
  .handler(async ({ context, input, errors }) => {
    // Validate that the requested model specifiers exist in the catalog.
    // If the info server is unreachable we let the request through. An outage
    // should not prevent operators from managing deployments.
    if (infoClient) {
      const client = infoClient;
      const specsToCheck = [
        { field: "modelSpecifier", specifier: input.modelSpecifier },
        ...(input.earlyModelSpecifier ? [{ field: "earlyModelSpecifier", specifier: input.earlyModelSpecifier }] : []),
      ];
      const statuses = await Promise.all(specsToCheck.map(async s => ({ ...s, status: await client.fetchModelStatus(s.specifier) })));
      const missing = statuses.find(s => s.status.status === "not_found");
      if (missing) {
        throw errors.BAD_REQUEST({ message: `Model "${missing.specifier}" was not found in the model catalog` });
      }
    }

    const rlog = log.child({ traceId: context.traceId });
    try {
      await validateCanaryModelTypes(input.modelSpecifier, input.earlyModelSpecifier);
    } catch (err: any) {
      throw errors.BAD_REQUEST({ message: err.message });
    }

    try {
      const [deployment] = await getDB()
        .insert(modelDeploymentT)
        .values({
          ...input,
          organizationId: context.activeOrganizationId,
        })
        .returning();
      void syncDeployedModels();
      const [org] = await getDB()
        .select({ name: organizationT.name })
        .from(organizationT)
        .where(sql`${organizationT.id} = ${context.activeOrganizationId}`)
        .limit(1);
      void notifyOrgMembers({
        type: NotificationType.deployment_created,
        organizationId: context.activeOrganizationId,
        data: {
          deploymentName: deployment.name,
          modelSpecifier: deployment.publicSpecifier,
          creatorName: context.session.user.name || context.session.user.email,
          orgName: org?.name ?? "",
          dashboardUrl: `${serverEnv.ORIGIN}/modelhub`,
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
  .handler(async ({ input }) => {
    return checkDeploymentCapacity(input);
  });

export const deploymentRouter = rootOs.prefix("/deployment").router({
  create: createDeployment,
  get: getDeployment,
  update: updateDeployment,
  delete: deleteDeployment,
  list: listDeployments,
  find: findDeployment,
  enable: toggleEnabled,
  checkCapacity,
});
