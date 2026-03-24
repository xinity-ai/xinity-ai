/**
 * Two-step CLI build:
 *   1. Bundle with Bun.build() + dashboard stub plugin
 *      (resolves SvelteKit virtual modules so the oRPC router can be bundled)
 *   2. Compile the bundle into a standalone binary with bun build --compile
 *
 * Usage:
 *   CLI_VERSION=v1.0.0 bun run build.ts --target bun-linux-x64
 *   bun run build.ts                           # defaults: target=bun-linux-x64, version=dev
 */
import { resolve } from "path";
import { parseArgs } from "util";
import { $ } from "bun";
import { serverStubs, serverStubSources, appStubSources } from "./src/lib/dashboard-stubs.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: "string", default: "bun-linux-x64" },
    outfile: { type: "string", default: "dist/xinity" },
  },
});

const target = values.target!;
const outfile = values.outfile!;

console.log(`Building ${outfile} for ${target}…`);

// ── Dashboard stub plugin (build-time) ──────────────────────────────────────
//
// Uses shared stub definitions from src/lib/dashboard-stubs.ts.
// Bun.build()'s plugin API (onResolve + onLoad) resolves SvelteKit virtual
// modules ($app/*, $lib/*) and inlines the oRPC router metadata.

const DASHBOARD_SRC = resolve(import.meta.dirname, "../xinity-ai-dashboard/src/lib");

/** Absolute-path map for catching relative imports that resolve to stub files. */
const stubsByAbsPath = new Map<string, string>();
for (const specifier of Object.keys(serverStubs)) {
  const relPath = specifier.replace("$lib/", "");
  stubsByAbsPath.set(resolve(DASHBOARD_SRC, relPath + ".ts"), serverStubSources[specifier]);
}

/** Regex matching filenames of stub targets (for the onLoad filter). */
const stubFileNames = Object.keys(serverStubs).map(
  (s) => s.split("/").pop()!.replace(".", "\\."),
);
const stubFileRegex = new RegExp(`(?:${stubFileNames.join("|")})\\.ts$`);

const dashboardStubPlugin: import("bun").BunPlugin = {
  name: "dashboard-stubs",
  setup(build) {
    // ── $app/* virtual modules ──────────────────────────────────────────
    build.onResolve({ filter: /^\$app\// }, (args) => ({
      path: args.path,
      namespace: "svelte-virtual",
    }));

    build.onLoad({ filter: /.*/, namespace: "svelte-virtual" }, (args) => {
      const source = appStubSources[args.path];
      if (source) return { contents: source, loader: "js" };
      return { contents: "export default {};", loader: "js" };
    });

    // ── $lib/* imports ──────────────────────────────────────────────────
    build.onResolve({ filter: /^\$lib\// }, (args) => {
      // Known stub?
      if (args.path in serverStubs) {
        return { path: args.path, namespace: "dashboard-stub" };
      }

      // Svelte components → stub
      if (args.path.endsWith(".svelte")) {
        return { path: args.path, namespace: "svelte-component" };
      }

      // Everything else → redirect to actual dashboard file
      const relPath = args.path.replace("$lib/", "");
      return { path: resolve(DASHBOARD_SRC, relPath + ".ts") };
    });

    build.onLoad({ filter: /.*/, namespace: "dashboard-stub" }, (args) => ({
      contents: serverStubSources[args.path] ?? "export default {};",
      loader: "js",
    }));

    build.onLoad({ filter: /.*/, namespace: "svelte-component" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));

    // ── Relative imports that resolve to stub files ─────────────────────
    // When dashboard code uses relative paths (e.g. `../../serverenv`)
    // that resolve to the same files we need to stub, intercept the load.
    build.onLoad({ filter: stubFileRegex }, (args) => {
      const contents = stubsByAbsPath.get(args.path);
      if (contents) return { contents, loader: "js" };
      // Not a stub target, fall through to default loader
    });

    // ── Any .svelte file (not from $lib/) ──────────────────────────────
    build.onLoad({ filter: /\.svelte$/ }, () => ({
      contents: "export default {};",
      loader: "js",
    }));

    // ── Stub out the runtime dashboard-plugin.ts ────────────────────────
    // It uses Bun's runtime plugin() API which is unnecessary when
    // building; the build plugin handles all stubs at bundle time.
    build.onResolve({ filter: /dashboard-plugin\.ts$/ }, () => ({
      path: "noop",
      namespace: "dashboard-stub",
    }));
  },
};

// ── Step 1: Bundle ──────────────────────────────────────────────────────────

const bundleResult = await Bun.build({
  entrypoints: [resolve(import.meta.dirname, "src/index.ts")],
  outdir: resolve(import.meta.dirname, "dist"),
  target: "bun",
  sourcemap: "linked",
  // Don't minify here: the compile step handles it. Bun.build()'s minifier
  // doesn't know about Bun runtime globals (e.g. awaitPromise used by the
  // shell API) and will mangle them, causing ReferenceErrors at runtime.
  // Keep "bun" as an external for the same reason: the compile step
  // embeds the Bun runtime and resolves these imports natively.
  external: ["bun"],
  plugins: [dashboardStubPlugin],
});

if (!bundleResult.success) {
  console.error("Bundle failed:");
  for (const log of bundleResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("Bundle OK");

// ── Step 2: Compile ─────────────────────────────────────────────────────────

const bundlePath = resolve(import.meta.dirname, "dist/index.js");
const result = await $`bun build --compile --minify --sourcemap=external --target=${target} ${bundlePath} --outfile ${outfile}`.nothrow();

if (result.exitCode !== 0) {
  console.error("Compile failed");
  process.exit(1);
}

console.log(`Done: ${outfile} (${target})`);
