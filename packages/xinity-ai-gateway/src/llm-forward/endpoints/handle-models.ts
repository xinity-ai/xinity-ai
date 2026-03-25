import { modelDeploymentT, modelInstallationT, organizationT, sql, type ModelDeployment, type ModelInstallation } from "common-db";
import { getDB } from "../../db";
import { checkAuth } from "../auth";

export async function handleModelsRequest(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization") || "";
  const authCheckResponse = await checkAuth(authHeader);
  if (authCheckResponse instanceof Response) {
    return authCheckResponse;
  }
  const { orgId } = authCheckResponse;

  const [organization] = await getDB().select().from(organizationT).where(sql`${organizationT.id} = ${orgId}`).limit(1);
  const models = await getDB()
    .select()
    .from(modelDeploymentT)
    .leftJoin(modelInstallationT, sql`
      (${modelDeploymentT.modelSpecifier} = ${modelInstallationT.model}
      OR ${modelDeploymentT.earlyModelSpecifier} = ${modelInstallationT.model})
      AND ${modelInstallationT.deletedAt} IS NULL`)
    .where(sql`${modelDeploymentT.organizationId} = ${orgId} AND ${modelDeploymentT.deletedAt} IS NULL`);

  const modelMap = new Map<string, { modelDeployment: ModelDeployment, modelInstallations: ModelInstallation[] }>();
  models.forEach(model => {
    if (modelMap.has(model.model_deployment.publicSpecifier)) {
      if (model.model_installation) {
        modelMap.get(model.model_deployment.publicSpecifier)?.modelInstallations.push(model.model_installation);
      }
    } else {
      modelMap.set(model.model_deployment.publicSpecifier, {
        modelDeployment: model.model_deployment,
        modelInstallations: model.model_installation ? [model.model_installation] : [],
      });
    }
  });

  const modelOutput = Array.from(modelMap.values()).map(model => {
    const isCanary = model.modelDeployment.progress !== 100;
    // Status is ready if there is at least one installation older then 5 min, loading if there is at least one, not_ready otherwise
    const status = model.modelInstallations.some(installation => installation.createdAt < new Date(Date.now() - 5 * 60 * 1000)) ? "ready" :
      model.modelInstallations.length > 0 ? "loading" : "not_ready";
    return {
      id: model.modelDeployment.publicSpecifier,
      object: "model",
      created: Math.floor(model.modelDeployment.createdAt.valueOf() / 1000),
      owned_by: organization?.slug || "organization",
      status,
      canary: isCanary,
    }
  })
  return new Response(JSON.stringify({
    object: "list",
    data: modelOutput,
  }), {
    headers: {
      "Content-Type": "application/json",
    },
    status: 200,
  })
}