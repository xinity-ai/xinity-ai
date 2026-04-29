/**
 * Two-step dashboard build:
 *   1. SvelteKit/Vite build (bundles devDependencies, marks runtime deps external)
 *   2. bun build --compile (bundles remaining runtime deps + embeds Bun runtime)
 *
 * Usage:
 *   bun run build.ts
 *   bun run build.ts --target bun-linux-arm64 --outfile dist/xinity-ai-dashboard
 */
import { parseArgs } from "util";
import { $ } from "bun";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: "string", default: "bun-linux-x64" },
    outfile: { type: "string", default: "xinity-ai-dashboard" },
    // Skip the Vite build step (used in CI where vite runs once before the
    // per-arch loop to avoid repeating the ~10 minute build three times).
    "no-vite": { type: "boolean", default: false },
  },
});

const target = values.target!;
const outfile = values.outfile!;

console.log(`Building ${outfile} for ${target}…`);

// ── Step 1: SvelteKit/Vite build ────────────────────────────────────────────

if (!values["no-vite"]) {
  const viteResult = await $`bun run build`.nothrow();
  if (viteResult.exitCode !== 0) {
    console.error("Vite build failed");
    process.exit(viteResult.exitCode ?? 1);
  }
  console.log("Vite build OK");
} else {
  console.log("Vite build skipped (--no-vite)");
}

// ── Step 2: Compile to standalone binary ────────────────────────────────────

// compile mode derives the output filename from the entrypoint path, ignoring
// naming/outfile options. Output to a temp dir then rename to the desired name.
const tmpDir = await import("os").then((os) => os.tmpdir());
const tmpOut = `${tmpDir}/bun-dashboard-compile-${Date.now()}`;

const buildResult = await Bun.build({
  entrypoints: ["build/index.js"],
  outdir: tmpOut,
  compile: true,
  minify: true,
  target: target as Parameters<typeof Bun.build>[0]["target"],
});

if (!buildResult.success) {
  console.error("Compile failed");
  for (const msg of buildResult.logs) {
    console.error(msg);
  }
  process.exit(1);
}

// Rename the compiled binary from its auto-derived name to the desired outfile.
const compiledPath = buildResult.outputs[0]!.path;
await $`mv ${compiledPath} ${outfile} && chmod +x ${outfile}`;

console.log(`Done: ${outfile} (${target})`);
