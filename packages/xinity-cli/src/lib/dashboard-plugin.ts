/**
 * Bun runtime plugin that stubs SvelteKit server-side modules
 * so the CLI can import the dashboard's oRPC router without triggering
 * database connections, auth initialization, or other side effects.
 *
 * Stub definitions live in dashboard-stubs.ts (single source of truth).
 * MUST be imported before any dashboard module imports.
 */
import { plugin } from "bun";
import { resolve } from "path";
import { serverStubs, appStubs, svelteComponentStubs } from "./dashboard-stubs.ts";

const DASHBOARD_SRC = resolve(import.meta.dirname, "../../../../packages/xinity-ai-dashboard/src/lib");

/**
 * $lib/ paths that are safe to load from their actual files
 * (pure Zod schemas and utility functions, no server dependencies).
 */
const safeRedirects = [
  "orpc/dtos/common.dto",
  "orpc/dtos/model.dto",
  "orpc/dtos/api-key.dto",
  "orpc/dtos/application.dto",
  "orpc/dtos/user.dto",
  "orpc/dtos/api-call.dto",
  "util",
];

plugin({
  name: "dashboard-stubs",
  setup(build) {
    // --- $app/* virtual module stubs ---
    for (const [specifier, exports] of Object.entries(appStubs)) {
      build.module(specifier, () => ({ exports, loader: "object" }));
    }

    // --- Server module stubs (by $lib/ specifier) ---
    for (const [specifier, exports] of Object.entries(serverStubs)) {
      build.module(specifier, () => ({ exports, loader: "object" }));
    }

    // --- Also register stubs by absolute path (for relative imports) ---
    for (const [specifier, exports] of Object.entries(serverStubs)) {
      const relPath = specifier.replace("$lib/", "");
      const absPath = resolve(DASHBOARD_SRC, relPath);
      build.module(absPath + ".ts", () => ({ exports, loader: "object" }));
      build.module(absPath, () => ({ exports, loader: "object" }));
    }

    // --- Safe $lib/* redirects to actual dashboard files ---
    for (const mod of safeRedirects) {
      const specifier = `$lib/${mod}`;
      const filePath = resolve(DASHBOARD_SRC, mod + ".ts");
      build.module(specifier, async () => {
        const real = await import(filePath);
        return { exports: real, loader: "object" };
      });
    }

    // --- Svelte component stubs ---
    for (const path of svelteComponentStubs) {
      build.module(path, () => ({ exports: { default: {} }, loader: "object" }));
    }
  },
});
