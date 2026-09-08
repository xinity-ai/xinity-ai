import { call } from "@orpc/server";
import { isRedirect, isHttpError } from "@sveltejs/kit";
import { router } from "$lib/server/orpc/router";
import { catalogClient } from "$lib/server/model-catalog";
import type { ModelType, ModelWithSpecifier } from "xinity-infoserver";
import type { DeploymentWithStatus } from "$lib/server/orpc/procedures/deployment.procedure";

export type OrgModel = {
  publicSpecifier: string;
  name: string;
  type: ModelType | null;
  tools: boolean;
  vision: boolean;
  ready: boolean;
};

export async function loadOrgModels(locals: App.Locals): Promise<OrgModel[]> {
  const deployments = (await listDeployments(locals)).filter(d => d.enabled);
  const catalog = await resolveCatalog(deployments.map(d => d.specifier));

  return deployments
    .map((deployment) => {
      const entry = catalog[deployment.specifier];
      return {
        publicSpecifier: deployment.publicSpecifier,
        name: deployment.name,
        type: entry?.type ?? null,
        tools: entry?.tags.includes("tools") ?? false,
        vision: entry?.tags.includes("vision") ?? false,
        ready: deployment.status?.phase === "ready",
      };
    })
    .sort((a, b) => Number(b.ready) - Number(a.ready) || a.name.localeCompare(b.name));
}

/** Lacking the read permission is a legitimate answer of "no models", not a failure. */
async function listDeployments(locals: App.Locals): Promise<DeploymentWithStatus[]> {
  try {
    return await call(router.deployment.list, { withStatus: true }, { context: locals });
  } catch (err) {
    if (isRedirect(err) || isHttpError(err)) throw err;
    return [];
  }
}

async function resolveCatalog(specifiers: string[]): Promise<Record<string, ModelWithSpecifier | null>> {
  try {
    return await catalogClient?.resolveBatch(specifiers) ?? {};
  } catch {
    return {};
  }
}
