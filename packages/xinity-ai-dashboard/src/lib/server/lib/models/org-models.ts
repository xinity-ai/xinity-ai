import { call } from "@orpc/server";
import { isRedirect, isHttpError } from "@sveltejs/kit";
import { calcCanaryProgress } from "common-db";
import { router } from "$lib/server/orpc/router";
import { catalogClient } from "$lib/server/lib/models/model-catalog";
import type { ModelType, ModelWithSpecifier } from "common-env/model-catalog";
import type { DeploymentWithStatus } from "$lib/orpc/dtos/model.dto";

export type OrgModel = {
  publicSpecifier: string;
  name: string;
  type: ModelType | null;
  tools: boolean;
  vision: boolean;
  ready: boolean;
  contextWindow: number;
};

const DEFAULT_CONTEXT_WINDOW = 131072;

// A canary request can land on either model, so only the shorter context is safe to rely on.
function servingSpecifiers(deployment: DeploymentWithStatus): string[] {
  const { earlySpecifier, progress, canaryProgressFrom = null, canaryProgressUntil = null } = deployment;
  return earlySpecifier && calcCanaryProgress({ earlySpecifier, progress, canaryProgressFrom, canaryProgressUntil }) !== 100
    ? [deployment.specifier, earlySpecifier]
    : [deployment.specifier];
}

export async function loadOrgModels(locals: App.Locals): Promise<OrgModel[]> {
  const deployments = (await listDeployments(locals)).filter(d => d.enabled);
  const catalog = await resolveCatalog([...new Set(deployments.flatMap(servingSpecifiers))]);

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
        contextWindow: Math.min(...servingSpecifiers(deployment)
          .map(specifier => catalog[specifier]?.sizing.maxContextLength ?? DEFAULT_CONTEXT_WINDOW)),
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
