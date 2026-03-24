/**
 * Dynamic route extraction from the dashboard's actual oRPC router.
 *
 * Routes are loaded lazily on first access (only the `act` command needs them).
 * SvelteKit virtual modules ($app/*, $lib/*) are resolved via:
 *   - Runtime:  dashboard-plugin.ts (Bun runtime plugin)
 *   - Build:    build.ts (Bun.build() bundler plugin)
 */
import type { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteInfo {
  /** HTTP method (GET, POST, etc.) */
  method: HttpMethod;
  /** HTTP path including prefix (e.g. /deployment/{id}) */
  path: string;
  /** Human-readable summary */
  summary: string;
  /** Zod input schema, if the route accepts input */
  input?: z.ZodType;
}

// ─── Lazy loading state ───────────────────────────────────────────────────

let _routes: Map<string, RouteInfo> | null = null;
let _loadError: string | null = null;

/**
 * Recursively walk the oRPC router tree, resolving lazy (prefixed) routers,
 * and collect route metadata from each procedure's `~orpc` definition.
 */
async function extractRoutes(routerObj: unknown): Promise<Map<string, RouteInfo>> {
  const { isProcedure, isLazy, getLazyMeta, unlazy } = await import("@orpc/server");

  const result = new Map<string, RouteInfo>();

  async function walk(obj: unknown, keyPath: string[], pathPrefix: string) {
    if (isProcedure(obj)) {
      const def = (obj as Record<string, any>)["~orpc"];
      const name = keyPath.join(".");
      const routePath = def.route?.path ?? "";
      const fullPath = pathPrefix + routePath;

      result.set(name, {
        method: (def.route?.method ?? "POST") as HttpMethod,
        path: fullPath,
        summary: def.route?.summary ?? name,
        input: def.inputSchema ?? undefined,
      });
      return;
    }

    if (isLazy(obj)) {
      const meta = getLazyMeta(obj);
      const prefix = (meta as Record<string, any>)?.prefix ?? "";
      const { default: resolved } = await unlazy(obj);
      await walk(resolved, keyPath, pathPrefix + prefix);
      return;
    }

    if (obj && typeof obj === "object") {
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        await walk(value, [...keyPath, key], pathPrefix);
      }
    }
  }

  await walk(routerObj, [], "");
  return result;
}

/** Lazily load routes from the dashboard router. */
export async function loadRoutes(): Promise<ReadonlyMap<string, RouteInfo>> {
  if (_routes !== null) return _routes;

  try {
    // Runtime plugin stubs SvelteKit modules; no-op in compiled binary
    // (build.ts resolves them at bundle time instead).
    await import("./dashboard-plugin.ts");
    const { router } = await import(
      "xinity-ai-dashboard/src/lib/server/orpc/router.ts"
    );
    _routes = await extractRoutes(router);
  } catch (err) {
    _loadError = (err as Error).message;
    _routes = new Map();
  }

  return _routes;
}

/** Sorted list of route names for completions. Lazy-loaded. */
export async function getRouteNames(): Promise<readonly string[]> {
  const routes = await loadRoutes();
  return [...routes.keys()].sort();
}

/** Error message if route loading failed, or null. */
export function getRouteLoadError(): string | null {
  return _loadError;
}
