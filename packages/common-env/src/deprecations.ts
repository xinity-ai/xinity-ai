export type Deprecation = {
  /** The first release that no longer carries it. */
  removedIn: string;
  /** ISO date the deprecation was announced. */
  deprecatedSince: string;
  summary: string;
};

/** Every deprecation an install can still depend on, declared once. */
export const deprecations = {
  "gateway.web-search-engine-url": {
    removedIn: "1.0.0",
    deprecatedSince: "2026-07-22",
    summary: "WEB_SEARCH_ENGINE_URL is no longer read. WEB_SEARCH_PROVIDER and WEB_SEARCH_CREDENTIAL replace it",
  },
  "infoserver.legacy-model-dir": {
    removedIn: "1.0.0",
    deprecatedSince: "2026-08-04",
    summary: "MODEL_LEGACY_DIR and the v1 catalog endpoints are removed",
  },
  "deployments.legacy-catalog": {
    removedIn: "1.0.0",
    deprecatedSince: "2026-08-05",
    summary: "Deployments can no longer resolve their model through the v1 catalog",
  },
  "dashboard.legacy-api-calls": {
    removedIn: "1.0.0",
    deprecatedSince: "2026-09-01",
    summary: "The legacy api_call table is dropped along with any calls still in it",
  },
} satisfies Record<string, Deprecation>;

export type DeprecationId = keyof typeof deprecations;

export type Removal = { removedIn: string; deprecatedSince?: string; summary: string };

/** What already went away. A deprecation moves here in the release that removes it. */
export const removals: Record<string, Removal> = {
  "nix.dashboard-public-llm-api-url": {
    removedIn: "0.19.1",
    summary: "The NixOS option services.xinity-ai-dashboard.publicLlmApiUrl is gone. gatewayUrl replaces it, without the /v1 suffix",
  },
  "dashboard.better-auth-url": {
    removedIn: "0.22.0",
    deprecatedSince: "2026-05-07",
    summary: "BETTER_AUTH_URL is no longer read. ORIGIN is the auth base URL",
  },
  "deployments.provider-model-specifiers": {
    removedIn: "0.22.0",
    deprecatedSince: "2026-05-07",
    summary: "Deployments and installations are identified by their canonical specifier only. The provider model columns, the modelSpecifier and earlyModelSpecifier API fields, the infoserver ?lookup= parameter and the gateway's provider model fallback are gone",
  },
  "infoserver.model-info-file": {
    removedIn: "0.22.0",
    deprecatedSince: "2026-04-23",
    summary: "MODEL_INFO_FILE is no longer read. MODEL_INFO_DIR replaces it",
  },
  "dashboard.public-llm-api-url": {
    removedIn: "0.22.0",
    deprecatedSince: "2026-04-29",
    summary: "PUBLIC_LLM_API_URL is no longer read. GATEWAY_URL replaces it, without the /v1 suffix",
  },
  "daemon.ai-node-drivers": {
    removedIn: "0.22.0",
    deprecatedSince: "2026-05-16",
    summary: "The ai_node.drivers column is dropped. Driver features and versions replace it",
  },
  "nix.dashboard-better-auth-url": {
    removedIn: "0.25.0",
    deprecatedSince: "2026-05-07",
    summary: "The NixOS option services.xinity-ai-dashboard.betterAuthUrl is gone. origin replaces it",
  },
};

/** An operator message saying what still depends on it and how to move off, or null when nothing does. */
export type DeprecationCheck = () => Promise<string | null>;

export type DeprecationChecks = Partial<Record<DeprecationId, DeprecationCheck>>;

export type DeprecationReport = { id: string; removedIn: string; message: string };

// A check that cannot run is reported, not skipped: unknown must never read as clean.
export async function reportDeprecations(checks: DeprecationChecks): Promise<DeprecationReport[]> {
  const registry: Record<string, Deprecation> = deprecations;
  const entries = Object.entries(checks) as [string, DeprecationCheck][];
  const reports = await Promise.all(entries.map(async ([id, check]) => {
    const message = await check().catch((err: unknown) => `Could not be checked: ${err instanceof Error ? err.message : String(err)}`);
    return message === null ? null : { id, removedIn: registry[id]!.removedIn, message };
  }));
  return reports.filter((report) => report !== null);
}

/** Whether an update to `targetVersion` (with or without a leading "v") no longer carries the deprecation. */
export function isRemovedBy(removedIn: string, targetVersion: string): boolean {
  return Bun.semver.order(targetVersion.replace(/^v/, ""), removedIn.replace(/^v/, "")) >= 0;
}
