import { calcCanaryProgress, modelDeploymentT, modelInstallationT, modelInstallationStateT, aiNodeT, organizationT, sql, deploymentMatchesInstallation, lifecycleStateEnum } from "common-db";
import { getDB } from "../../db";
import { checkAuth } from "../auth";
import { getCatalogClient, getInfoClient } from "../model-data";
import { rootLogger } from "../../logger";

const TRUTHY_QUERY_VALUES = new Set(["true", "1"]);

type LifecycleState = typeof lifecycleStateEnum.enumValues[number];
type InstallationLifecycle = LifecycleState | null;

const LIFECYCLE_PRIORITY: Record<LifecycleState, number> = {
  ready: 4,
  installing: 3,
  downloading: 2,
  failed: 1,
};

function deriveStatus(lifecycles: InstallationLifecycle[]): LifecycleState | null {
  if (lifecycles.length === 0) {
    return null;
  }
  const concrete: LifecycleState[] = lifecycles.map(l => l ?? "downloading");
  return concrete.reduce((best, current) => {
    return LIFECYCLE_PRIORITY[current] > LIFECYCLE_PRIORITY[best] ? current : best;
  });
}

/**
 * Specifiers left out of the result fall back to the caller's default, which is also
 * how an unreachable catalog is handled: a listing of deployments is still useful
 * without context lengths, so it degrades rather than failing.
 */
async function resolveMaxContextLengths(specifiers: string[]): Promise<Map<string, number>> {
  const resolved = new Map<string, number>();
  const unresolved: string[] = [];

  try {
    const fromCatalog = await getCatalogClient().resolveBatch(specifiers);
    for (const [specifier, model] of Object.entries(fromCatalog)) {
      if (model) {
        resolved.set(specifier, model.maxContextLength);
      } else {
        unresolved.push(specifier);
      }
    }
  } catch (err) {
    rootLogger.warn({ err }, "Catalog unavailable, listing models without context lengths");
    return resolved;
  }

  if (unresolved.length === 0) {
    return resolved;
  }

  // Pre-per-engine deployments. Removed before 1.0.0.
  try {
    const fromLegacy = await getInfoClient().fetchModelsBatch(unresolved);
    for (const [specifier, model] of Object.entries(fromLegacy)) {
      if (model?.maxContextLength !== undefined) {
        resolved.set(specifier, model.maxContextLength);
      }
    }
  } catch (err) {
    rootLogger.warn({ err }, "Deprecated catalog unavailable, defaulting context length");
  }
  return resolved;
}

export async function handleModelsRequest(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization") || "";
  const authCheckResponse = await checkAuth(authHeader);
  if (authCheckResponse instanceof Response) {
    return authCheckResponse;
  }
  const { orgId } = authCheckResponse;

  const includeUnavailable = TRUTHY_QUERY_VALUES.has(
    (new URL(req.url).searchParams.get("include_unavailable") ?? "").toLowerCase(),
  );

  const [orgRows, models] = await Promise.all([
    getDB().select().from(organizationT).where(sql`${organizationT.id} = ${orgId}`).limit(1),
    getDB()
      .select()
      .from(modelDeploymentT)
      .leftJoin(modelInstallationT, sql`${deploymentMatchesInstallation} AND ${modelInstallationT.deletedAt} IS NULL`)
      .leftJoin(aiNodeT, sql`${modelInstallationT.nodeId} = ${aiNodeT.id} AND ${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`)
      .leftJoin(modelInstallationStateT, sql`${modelInstallationStateT.id} = ${modelInstallationT.id}`)
      .where(sql`${modelDeploymentT.organizationId} = ${orgId} AND ${modelDeploymentT.deletedAt} IS NULL`),
  ]);
  const [organization] = orgRows;

  const rowsByDeployment = Map.groupBy(models, (row) => row.model_deployment.publicSpecifier);
  const uniqueSpecifiers = [...rowsByDeployment.keys()];
  const metaMap = uniqueSpecifiers.length > 0
    ? await resolveMaxContextLengths(uniqueSpecifiers)
    : new Map<string, number>();
  const modelOutput = [...rowsByDeployment.values()].map((rows) => {
    const deployment = rows[0]!.model_deployment;
    const lifecycles: InstallationLifecycle[] = rows
      .filter((r) => r.model_installation && r.ai_node)
      .map((r) => r.model_installation_state?.lifecycleState ?? null);
    return {
      id: deployment.publicSpecifier,
      object: "model",
      created: Math.floor(deployment.createdAt.valueOf() / 1000),
      owned_by: organization?.slug || "organization",
      status: deriveStatus(lifecycles),
      canary: calcCanaryProgress(deployment) !== 100,
      max_model_len: metaMap.get(deployment.publicSpecifier) ?? 131072,
    };
  });
  const visibleModels = includeUnavailable
    ? modelOutput
    : modelOutput.filter(model => model.status === "ready");

  return Response.json({ object: "list", data: visibleModels });
}
