import { rootOs, withOrganization, requirePermission } from "../root";
import { commonInputFilter } from "$lib/orpc/dtos/common.dto";
import { sql, isNull, modelDeploymentT, modelInstallationT, modelInstallationStateT, organizationT, aiNodeT, type ModelDeployment } from "common-db";
import z from "zod";
import { DeploymentDto } from "$lib/orpc/dtos/model.dto";
import { getDB } from "$lib/server/db";
import { syncDeployedModels } from "$lib/server/lib/orchestration.mod";
import { infoClient } from "$lib/server/info-client";
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

  // Fetch model info for all models
  const modelInfos = await Promise.all(
    modelsToCheck.map(async (m) => {
      const info = await infoClient?.fetchModel(m.specifier);
      if (!info) return null;
      const effectiveKvCache = Math.max(m.kvCacheSize ?? 0, info.minKvCache);
      return { ...m, perReplica: info.weight + effectiveKvCache };
    }),
  );
  const resolved = modelInfos.filter((m): m is NonNullable<typeof m> => m !== null);
  if (resolved.length === 0) return { deployable: true }; // Can't validate without model info; let orchestration handle it

  // Get current cluster free capacity per node (sorted descending for greedy allocation)
  const nodes = await getDB().select().from(aiNodeT).where(sql`${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`);
  const installations = await getDB().select().from(modelInstallationT).where(isNull(modelInstallationT.deletedAt));

  const nodeUsed = new Map<string, number>();
  for (const inst of installations) {
    nodeUsed.set(inst.nodeId, (nodeUsed.get(inst.nodeId) ?? 0) + inst.estCapacity);
  }

  const nodeFree = nodes
    .map((n) => ({ id: n.id, free: n.estCapacity - (nodeUsed.get(n.id) ?? 0) }))
    .sort((a, b) => b.free - a.free);

  // Greedily allocate replicas across nodes (models can share nodes but each replica consumes capacity)
  const remaining = nodeFree.map((n) => ({ ...n }));
  for (const model of resolved) {
    let placed = 0;
    for (const node of remaining) {
      if (placed >= model.replicas) break;
      if (node.free >= model.perReplica) {
        node.free -= model.perReplica;
        placed++;
      }
    }
    if (placed < model.replicas) {
      return {
        deployable: false,
        reason: `Insufficient cluster capacity: cannot place ${model.replicas} ${model.replicas === 1 ? "replica" : "replicas"} of "${model.specifier}" (${model.perReplica.toFixed(1)} GB each). Only ${placed} ${placed === 1 ? "node has" : "nodes have"} enough free capacity`,
      };
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

const listDeployments = rootOs.use(withOrganization)
  .use(requirePermission({ modelDeployment: ["read"] }))
  .route({ path: "/", method: "GET", tags, summary: "List Deployments", description: "Lists deployments accessible to the current user" })
  .input(z.object({ withStatus: z.coerce.boolean().default(false) }))
  .output(DeploymentDto.extend({
    status: z.object({
      phase: z.enum(["ready", "downloading", "installing", "failed", "scheduling"]),
      progress: z.number().nullable(),
      error: z.string().nullable().optional(),
      failureLogs: z.string().nullable().optional(),
    }).optional(),
  }).array())
  .handler(async ({ context, input }) => {
    const orgCondition = sql`${modelDeploymentT.organizationId} = ${context.activeOrganizationId} AND ${modelDeploymentT.deletedAt} IS NULL`;
    if (input?.withStatus) {
      const rows = await getDB()
        .select()
        .from(modelDeploymentT)
        .leftJoin(modelInstallationT, sql`
          (${modelDeploymentT.modelSpecifier} = ${modelInstallationT.model}
          OR
          ${modelDeploymentT.earlyModelSpecifier} = ${modelInstallationT.model})
          AND ${modelInstallationT.deletedAt} IS NULL`)
        .leftJoin(modelInstallationStateT, sql`${modelInstallationStateT.id} = ${modelInstallationT.id}`)
        .where(orgCondition);

      type StatusPhase = "ready" | "downloading" | "installing" | "failed" | "scheduling";
      const deployments: Array<{ deployment: ModelDeployment; status?: { phase: StatusPhase; progress: number | null } }> = [];
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

        // Installation exists but daemon hasn't reported state yet → scheduling phase
        if (installation && !state) {
          entry.phaseInfo = aggregatePhase(entry.phaseInfo, "scheduling", null, null);
          continue;
        }

        if (!state) continue;

        const phase = state.lifecycleState;
        const progress = (phase === "downloading" || phase === "installing") ? (state.progress ?? null) : null;
        entry.phaseInfo = aggregatePhase(entry.phaseInfo, phase, progress, state.errorMessage, state.failureLogs);
      }

      for (const entry of deploymentMap.values()) {
        const status = entry.phaseInfo
          ? {
              phase: entry.phaseInfo.phase as StatusPhase,
              progress: entry.phaseInfo.progress,
              error: entry.phaseInfo.error,
              failureLogs: entry.phaseInfo.failureLogs,
            }
          : undefined;
        deployments.push({ deployment: entry.deployment, status });
      }

      return deployments.map(({ deployment, status }) => status ? { ...deployment, status } : deployment);
    }
    return await getDB().select().from(modelDeploymentT).where(orgCondition)
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
  .errors({ NOT_FOUND: {}, BAD_REQUEST: {}, INSUFFICIENT_CAPACITY: {} })
  .handler(async ({ context, input, errors }) => {
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

    const deployment = await internalUpdateDeployment(context.activeOrganizationId, input.id, input);
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
  .input(z.object({ id: z.uuid() }))
  .output(DeploymentDto)
  .errors({ NOT_FOUND: {} })
  .handler(async ({ context, input, errors }) => {
    const [deployment] = await getDB().select().from(modelDeploymentT)
      .where(sql`
        ${modelDeploymentT.id} = ${input.id}
      AND
        ${modelDeploymentT.organizationId} = ${context.activeOrganizationId}
      AND
        ${modelDeploymentT.deletedAt} IS NULL`).limit(1);
    if (!deployment) {
      throw errors.NOT_FOUND();
    }
    return deployment as z.infer<typeof DeploymentDto>;
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
      }).catch((err: unknown) => log.error({ err }, "Failed to send deployment created notification"));
      return deployment;
    } catch (err) {
      log.error(err);
      throw errors.CONFLICT({ message: "A deployment of the same name already exists in your organization" })
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
