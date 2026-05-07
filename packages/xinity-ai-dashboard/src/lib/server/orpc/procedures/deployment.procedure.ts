import { rootOs, withOrganization, requirePermission } from "../root";
import { commonInputFilter } from "$lib/orpc/dtos/common.dto";
import { sql, modelDeploymentT, modelInstallationT, modelInstallationStateT, organizationT, deploymentMatchesInstallation, type ModelDeployment } from "common-db";
import z from "zod";
import { DeploymentDto } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { syncDeployedModels } from "$lib/server/lib/orchestration.mod";
import { infoClient } from "$lib/server/info-client";
import { buildClusterCapacity } from "./cluster.procedure";
import { resolveDefaultProvider, resolveMinVersionForDriver, resolveRequiredPlatformsForDriver, checkNodeCompatibility, deploymentLookup, deploymentEarlyLookup, lookupKey, type ModelNodeRequirements, type Provider, type ModelLookup } from "xinity-infoserver";
import { rootLogger } from "$lib/server/logging";
import { aggregatePhase, type PhaseInfo } from "$lib/server/lib/deployment-phase";
import { notifyOrgMembers } from "$lib/server/notifications/notification.service";
import { NotificationType } from "$lib/server/notifications/events";
import { serverEnv } from "$lib/server/serverenv";
const log = rootLogger.child({ name: "deployment.orpc" });

const tags = ["Deployment"];
const SuccessDto = z.object({ success: z.literal(true) });
const successObject = { success: true } as const;

async function deriveProviderModel(lookup: ModelLookup, preferredDriver: Provider | null): Promise<string | undefined> {
  if (!infoClient) return undefined;
  const status = await infoClient.fetchModelStatus(lookup);
  if (status.status !== "found") return undefined;
  const model = status.model;
  if (preferredDriver && model.providers[preferredDriver]) return model.providers[preferredDriver];
  return resolveDefaultProvider(model)?.providerModel;
}

/** Validates that primary and canary models share the same type. */
async function validateCanaryModelTypes(primary: ModelLookup, early: ModelLookup | null) {
  if (!early) return;
  const primaryModel = await infoClient?.fetchModel(primary);
  const earlyModel = await infoClient?.fetchModel(early);
  if (primaryModel?.type && earlyModel?.type && primaryModel.type !== earlyModel.type) {
    throw new Error(`Cannot mix model types in a canary deployment: primary is "${primaryModel.type}" but canary is "${earlyModel.type}"`);
  }
}

const CapacityCheckInput = z.object({
  specifier: z.string().trim().nullish(),
  earlySpecifier: z.string().trim().nullish(),
  /** @deprecated Pass the canonical {@link specifier} instead. */
  modelSpecifier: z.string().trim().optional(),
  /** @deprecated Pass {@link earlySpecifier} instead. */
  earlyModelSpecifier: z.string().trim().nullish(),
  replicas: z.number().default(1),
  progress: z.number().default(100),
  kvCacheSize: z.number().nullish(),
  earlyKvCacheSize: z.number().nullish(),
  preferredDriver: z.enum(["ollama", "vllm"]).nullish(),
}).refine(d => d.specifier || d.modelSpecifier, { message: "Either `specifier` or `modelSpecifier` must be provided", path: ["specifier"] });

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
  const primaryLookup = deploymentLookup(input);
  if (!primaryLookup) {
    return { deployable: false, reason: "Capacity check requires a model identifier" };
  }
  const earlyLookup = deploymentEarlyLookup(input);
  const isCanary = input.progress < 100 && !!earlyLookup;

  // Build the list of models that need capacity
  const modelsToCheck: { lookup: ModelLookup; label: string; replicas: number; kvCacheSize: number | null | undefined }[] = [];
  if (isCanary) {
    modelsToCheck.push(
      { lookup: primaryLookup, label: lookupKey(primaryLookup), replicas: Math.ceil(input.replicas * (input.progress / 100)), kvCacheSize: input.kvCacheSize },
      { lookup: earlyLookup!, label: lookupKey(earlyLookup!), replicas: Math.ceil(input.replicas * ((100 - input.progress) / 100)), kvCacheSize: input.earlyKvCacheSize ?? input.kvCacheSize },
    );
  } else {
    modelsToCheck.push({ lookup: primaryLookup, label: lookupKey(primaryLookup), replicas: input.replicas, kvCacheSize: input.kvCacheSize });
  }

  // Fetch model info for all models, distinguishing not_found from unavailable
  const modelInfos = await Promise.all(
    modelsToCheck.map(async (m) => {
      const status = await infoClient?.fetchModelStatus(m.lookup);
      if (!status || status.status === "unavailable") return { kind: "unavailable" as const, label: m.label };
      if (status.status === "not_found") return { kind: "not_found" as const, label: m.label };
      const info = status.model;
      const effectiveKvCache = Math.max(m.kvCacheSize ?? 0, info.minKvCache);
      const driver: Provider | undefined = input.preferredDriver ?? resolveDefaultProvider(info)?.driver;
      const minVersion = driver ? resolveMinVersionForDriver(info, driver) : undefined;
      const requiredPlatforms = driver ? resolveRequiredPlatformsForDriver(info, driver) : [];
      return { kind: "found" as const, label: m.label, replicas: m.replicas, perReplica: info.weight + effectiveKvCache, driver, minVersion, requiredPlatforms };
    }),
  );

  const notFound = modelInfos.find(m => m.kind === "not_found");
  if (notFound) return { deployable: false, reason: `Model "${notFound.label}" was not found in the model catalog` };

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
        ? `No compatible node for "${model.label}" (requires ${model.driver}${model.minVersion ? ` >= ${model.minVersion}` : ""}${model.requiredPlatforms.length ? `, platform: ${model.requiredPlatforms.join("/")}` : ""})`
        : `Insufficient cluster capacity: cannot place ${model.replicas} ${model.replicas === 1 ? "replica" : "replicas"} of "${model.label}" (${model.perReplica.toFixed(1)} GB each). Only ${placed} compatible ${placed === 1 ? "node has" : "nodes have"} enough free capacity`;
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
    .leftJoin(modelInstallationT, sql`${deploymentMatchesInstallation} AND ${modelInstallationT.deletedAt} IS NULL`)
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
        const client = infoClient;
        const isMissing = async (lookup: ModelLookup | null): Promise<boolean> => {
          if (!lookup) return false;
          try {
            const status = await client.fetchModelStatus(lookup);
            return status.status === "not_found";
          } catch {
            return false;
          }
        };
        await Promise.all(noStatusEnabled.map(async (entry) => {
          const [primaryMissing, earlyMissing] = await Promise.all([
            isMissing(deploymentLookup(entry)),
            isMissing(deploymentEarlyLookup(entry)),
          ]);
          if (primaryMissing || earlyMissing) {
            entry.status = { phase: "not_in_catalog", progress: null, error: null };
          }
        }));
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
    if (input.modelSpecifier) {
      try {
        await validateCanaryModelTypes(deploymentLookup(input), deploymentEarlyLookup(input));
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
        { field: "specifier", changed: input.specifier !== undefined && input.specifier !== current.specifier },
        { field: "earlySpecifier", changed: input.earlySpecifier !== undefined && input.earlySpecifier !== current.earlySpecifier },
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
    if (!input.specifier) {
      throw errors.BAD_REQUEST({ message: "specifier is required when creating a deployment" });
    }
    const primaryLookup: ModelLookup = { kind: "canonical", specifier: input.specifier };
    const earlyLookup: ModelLookup | null = input.earlySpecifier
      ? { kind: "canonical", specifier: input.earlySpecifier }
      : null;

    if (infoClient) {
      const client = infoClient;
      const checks: { label: string; lookup: ModelLookup }[] = [
        { label: input.specifier, lookup: primaryLookup },
        ...(earlyLookup ? [{ label: input.earlySpecifier!, lookup: earlyLookup }] : []),
      ];
      const statuses = await Promise.all(checks.map(async c => ({ ...c, status: await client.fetchModelStatus(c.lookup) })));
      const missing = statuses.find(s => s.status.status === "not_found");
      if (missing) {
        throw errors.BAD_REQUEST({ message: `Model "${missing.label}" was not found in the model catalog` });
      }
    }

    const rlog = log.child({ traceId: context.traceId });
    try {
      await validateCanaryModelTypes(primaryLookup, earlyLookup);
    } catch (err: any) {
      throw errors.BAD_REQUEST({ message: err.message });
    }

    const derivedModelSpecifier = await deriveProviderModel(primaryLookup, input.preferredDriver ?? null) ?? input.modelSpecifier;
    const derivedEarlyModelSpecifier = earlyLookup
      ? (await deriveProviderModel(earlyLookup, input.preferredDriver ?? null) ?? input.earlyModelSpecifier ?? null)
      : null;

    try {
      const [deployment] = await getDB()
        .insert(modelDeploymentT)
        .values({
          ...input,
          specifier: input.specifier,
          earlySpecifier: input.earlySpecifier ?? null,
          modelSpecifier: derivedModelSpecifier,
          earlyModelSpecifier: derivedEarlyModelSpecifier,
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
