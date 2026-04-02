import type { CommandModule } from "yargs";
import * as p from "../lib/clack.ts";
import pc from "picocolors";
import { loadRoutes, getRouteNames, getRouteLoadError, type RouteInfo } from "../lib/routes.ts";
import { promptForSchema } from "../lib/schema-prompt.ts";
import { resolveConfigValue, ENV_VAR_MAP } from "../lib/config.ts";
import { workflows, workflowNames } from "../lib/workflows.ts";

const DEFAULT_DASHBOARD_URL = "http://localhost:5173";
const REQUEST_TIMEOUT_MS = 15_000;

/** Routes that are known to not require an API key. */
const UNAUTHENTICATED_ROUTES = new Set(workflowNames);

function getDashboardUrl(argv: { url?: string }): string {
  return argv.url ?? resolveConfigValue("dashboardUrl") ?? DEFAULT_DASHBOARD_URL;
}

function getApiKey(argv: { "api-key"?: string }): string | undefined {
  return argv["api-key"] ?? resolveConfigValue("apiKey");
}

/**
 * Validate that required variables are present and provide clear instructions
 * when they are missing.
 */
function requireApiKey(argv: { "api-key"?: string }, routeName: string): string {
  const key = getApiKey(argv);
  if (key) return key;

  p.log.error(`Missing API key, required for ${pc.cyan(routeName)}.`);
  p.log.info(
    [
      "Provide it via one of:",
      `  ${pc.cyan("--api-key")} flag`,
      `  ${pc.cyan(ENV_VAR_MAP.apiKey)} environment variable`,
      `  ${pc.cyan("xinity configure apiKey")} (persistent)`,
    ].join("\n"),
  );
  process.exit(1);
}

function warnDefaultDashboardUrl(argv: { url?: string }): void {
  const explicit = argv.url ?? resolveConfigValue("dashboardUrl");
  if (!explicit) {
    p.log.warn(
      `No dashboard URL configured, falling back to ${pc.cyan(DEFAULT_DASHBOARD_URL)}. ` +
      `Set via ${pc.cyan(ENV_VAR_MAP.dashboardUrl)} or ${pc.cyan("xinity configure dashboardUrl")}.`,
    );
  }
}

/** Substitute path parameters like {id} with values from the data object. */
function buildUrl(basePath: string, data: Record<string, unknown>): {
  url: string;
  remainingData: Record<string, unknown>;
} {
  let url = basePath;
  const remaining = { ...data };
  const paramRegex = /\{(\w+)\}/g;
  let match;
  while ((match = paramRegex.exec(basePath)) !== null) {
    const param = match[1]!;
    if (param in remaining) {
      url = url.replace(`{${param}}`, encodeURIComponent(String(remaining[param])));
      delete remaining[param];
    }
  }
  return { url, remainingData: remaining };
}

async function callRoute(
  route: RouteInfo,
  dashboardUrl: string,
  apiKey: string | undefined,
  data: Record<string, unknown>,
) {
  const base = dashboardUrl.replace(/\/$/, "");
  const { url: path, remainingData } = buildUrl(route.path, data);
  const fullUrl = `${base}/api${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const hasBody = route.method !== "GET" && route.method !== "DELETE";

  // For GET requests, add remaining data as query params
  let fetchUrl = fullUrl;
  if (route.method === "GET" && Object.keys(remainingData).length > 0) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(remainingData)) {
      if (v !== undefined) params.set(k, String(v));
    }
    fetchUrl = `${fullUrl}?${params}`;
  }

  const spin = p.spinner();
  spin.start(`${route.method} ${path}`);

  let res: Response;
  try {
    res = await fetch(fetchUrl, {
      method: route.method,
      headers,
      body: hasBody && Object.keys(remainingData).length > 0
        ? JSON.stringify(remainingData)
        : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    spin.error("Request failed");
    if (err instanceof DOMException && err.name === "TimeoutError") {
      p.log.error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Is the dashboard running at ${pc.cyan(dashboardUrl)}?`);
    } else if (err instanceof TypeError) {
      p.log.error(`Could not connect to ${pc.cyan(dashboardUrl)}. Is the dashboard running?`);
    } else {
      p.log.error(String(err));
    }
    process.exit(1);
  }

  if (!res.ok) {
    spin.error(`${route.method} ${path} failed (${res.status})`);
    const text = await res.text();
    if (text) p.log.message(text);
    process.exit(1);
  }

  spin.stop(`${route.method} ${path}`);
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}

/** Pre-loaded route choices for shell completion (populated before yargs runs). */
let _preloadedChoices: string[] | null = null;

/** Call before yargs.parse() so the synchronous builder can supply choices. */
export async function preloadActChoices() {
  try {
    const names = await getRouteNames();
    _preloadedChoices = [...names, ...workflowNames];
  } catch {
    _preloadedChoices = [];
  }
}

export const actCommand: CommandModule = {
  command: "act [route] [data]",
  describe: "Call a dashboard API route",
  builder: (yargs) =>
    yargs
      .positional("route", {
        describe: "API route in dot-notation (e.g. deployment.list)",
        type: "string",
        ..._preloadedChoices ? { choices: _preloadedChoices } : {},
      })
      .positional("data", {
        describe: "JSON request body (or - for stdin)",
        type: "string",
      })
      .option("api-key", {
        describe: "API key for authentication",
        type: "string",
      })
      .option("url", {
        describe: "Dashboard URL override",
        type: "string",
      })
      .option("list-routes", {
        describe: "List all available API routes",
        type: "boolean",
        default: false,
      }),
  handler: async (argv) => {
    const routes = await loadRoutes();
    const routeNames = await getRouteNames();

    if (argv["list-routes"]) {
      const loadError = getRouteLoadError();
      if (loadError) {
        p.log.warn(loadError);
      }
      for (const name of workflowNames) {
        console.log(
          `  ${pc.cyan(name.padEnd(35))} ${pc.dim("multi".padEnd(7))} ${pc.dim("-")}  ${pc.bold("Composite workflow")}`,
        );
      }
      for (const name of routeNames) {
        if (workflows[name]) continue; // covered by workflow
        const r = routes.get(name)!;
        console.log(
          `  ${pc.cyan(name.padEnd(35))} ${pc.dim(r.method.padEnd(7))} ${pc.dim(r.path)}  ${r.summary}`,
        );
      }
      return;
    }

    const routeName = argv.route as string | undefined;
    if (!routeName) {
      p.log.error("Missing route argument.");
      p.log.info(`Run ${pc.cyan("xinity act --list-routes")} to see available routes`);
      process.exit(1);
    }

    warnDefaultDashboardUrl(argv as { url?: string });
    const dashboardUrl = getDashboardUrl(argv as { url?: string });

    // Handle composite workflows (e.g. "setup")
    const workflow = workflows[routeName];
    if (workflow) {
      await workflow(dashboardUrl);
      return;
    }

    const route = routes.get(routeName);
    if (!route) {
      p.log.error(`Unknown route: ${pc.cyan(routeName)}`);
      p.log.info(`Run ${pc.cyan("xinity act --list-routes")} to see available routes`);
      process.exit(1);
    }

    // Require API key for authenticated routes
    const isUnauthenticated = UNAUTHENTICATED_ROUTES.has(routeName);
    const apiKey = isUnauthenticated
      ? getApiKey(argv as { "api-key"?: string })
      : requireApiKey(argv as { "api-key"?: string }, routeName);

    // Resolve input data
    let data: Record<string, unknown> = {};
    const rawData = argv.data as string | undefined;

    if (rawData === "-") {
      if (process.stdin.isTTY) {
        p.log.error("Cannot read from stdin: no piped input detected.");
        p.log.info(`Usage: ${pc.cyan("echo '{...}' | xinity act " + routeName + " -")}`);
        process.exit(1);
      }
      const input = await Bun.stdin.text();
      if (!input.trim()) {
        p.log.error("Empty stdin input.");
        process.exit(1);
      }
      try {
        data = JSON.parse(input);
      } catch {
        p.log.error("Invalid JSON from stdin.");
        process.exit(1);
      }
    } else if (rawData) {
      data = JSON.parse(rawData);
    } else if (route.input) {
      // No data provided, prompt interactively for each field
      p.intro(`${pc.cyan(routeName)} ${pc.dim(`(${route.summary})`)}`);
      data = await promptForSchema(route.input);
    }

    await callRoute(route, dashboardUrl, apiKey, data);
  },
};
