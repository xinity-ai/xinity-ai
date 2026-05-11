import { modelDeploymentT, modelInstallationT, modelInstallationStateT, organizationT, sql, deploymentMatchesInstallation, type ModelDeployment, lifecycleStateEnum } from "common-db";
import { getDB } from "../../db";
import { checkAuth } from "../auth";

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

  const [organization] = await getDB().select().from(organizationT).where(sql`${organizationT.id} = ${orgId}`).limit(1);
  const models = await getDB()
    .select()
    .from(modelDeploymentT)
    .leftJoin(modelInstallationT, sql`${deploymentMatchesInstallation} AND ${modelInstallationT.deletedAt} IS NULL`)
    .leftJoin(modelInstallationStateT, sql`${modelInstallationStateT.id} = ${modelInstallationT.id}`)
    .where(sql`${modelDeploymentT.organizationId} = ${orgId} AND ${modelDeploymentT.deletedAt} IS NULL`);

  const modelMap = new Map<string, { modelDeployment: ModelDeployment; lifecycles: InstallationLifecycle[] }>();
  models.forEach(row => {
    const key = row.model_deployment.publicSpecifier;
    const lifecycle: InstallationLifecycle = row.model_installation
      ? (row.model_installation_state?.lifecycleState ?? null)
      : null;
    const entry = modelMap.get(key);
    if (entry) {
      if (row.model_installation) {
        entry.lifecycles.push(lifecycle);
      }
    } else {
      modelMap.set(key, {
        modelDeployment: row.model_deployment,
        lifecycles: row.model_installation ? [lifecycle] : [],
      });
    }
  });

  const modelOutput = Array.from(modelMap.values()).map(model => ({
    id: model.modelDeployment.publicSpecifier,
    object: "model",
    created: Math.floor(model.modelDeployment.createdAt.valueOf() / 1000),
    owned_by: organization?.slug || "organization",
    status: deriveStatus(model.lifecycles),
    canary: model.modelDeployment.progress !== 100,
  }));
  const visibleModels = includeUnavailable
    ? modelOutput
    : modelOutput.filter(model => model.status === "ready");

  return new Response(JSON.stringify({
    object: "list",
    data: visibleModels,
  }), {
    headers: {
      "Content-Type": "application/json",
    },
    status: 200,
  })
}