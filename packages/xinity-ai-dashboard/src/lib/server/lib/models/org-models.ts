import { call } from "@orpc/server";
import { isRedirect, isHttpError } from "@sveltejs/kit";
import { calcCanaryProgress } from "common-db";
import { router } from "$lib/server/orpc/router";
import { catalogClient } from "$lib/server/lib/models/model-catalog";
import type { ModelType, ModelWithSpecifier } from "common-env/model-catalog";
import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
import { handleVariant, type VariantHandlers } from "$lib/util";

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

// The model the deployment is described by comes first. A canary request can land on either model, so only the shorter
// context is safe to rely on.
const SERVING_SPECIFIERS: VariantHandlers<DeploymentOutput, string[]> = {
  legacy: ({ legacy }) => {
    const { specifier, earlySpecifier, progress, canaryProgressFrom = null, canaryProgressUntil = null } = legacy;
    return earlySpecifier && calcCanaryProgress({ earlySpecifier, progress, canaryProgressFrom, canaryProgressUntil }) !== 100
      ? [specifier, earlySpecifier]
      : [specifier];
  },
  managed: ({ managed }) => [managed.specifier],
  canary: ({ canary }) => {
    const { from, to, progress, canaryProgressFrom = null, canaryProgressUntil = null } = canary;
    return calcCanaryProgress({ earlySpecifier: from.specifier, progress, canaryProgressFrom, canaryProgressUntil }) !== 100
      ? [to.specifier, from.specifier]
      : [to.specifier];
  },
};

const servingSpecifiers = (deployment: DeploymentOutput) => handleVariant(SERVING_SPECIFIERS, deployment);

export async function loadOrgModels(locals: App.Locals): Promise<OrgModel[]> {
  const deployments = (await listDeployments(locals)).filter(d => d.enabled);
  const catalog = await resolveCatalog([...new Set(deployments.flatMap(servingSpecifiers))]);

  return deployments
    .map((deployment) => {
      const entry = catalog[servingSpecifiers(deployment)[0]];
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
async function listDeployments(locals: App.Locals): Promise<DeploymentOutput[]> {
  try {
    return await call(router.deployments.list, { withStatus: true }, { context: locals });
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
