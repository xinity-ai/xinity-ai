/**
 * Dashboard build, on top of the SvelteKit/Vite build (devDependencies bundled, runtime deps external):
 *   --bundle  build/index.js plus its static files, run with `bun build/index.js`
 *   default   standalone binary with the Bun runtime and every dependency embedded
 *
 * Usage:
 *   bun run build.ts --bundle --no-vite
 *   bun run build.ts
 *   bun run build.ts --target bun-linux-arm64 --outfile dist/xinity-ai-dashboard
 */
import { parseArgs } from "node:util";
import { rmSync } from "node:fs";
import { $ } from "bun";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    bundle: { type: "boolean", default: false },
    target: { type: "string", default: "bun-linux-x64" },
    outfile: { type: "string", default: "xinity-ai-dashboard" },
    // Skip the Vite build step (used in CI where vite runs once before the
    // per-arch loop to avoid repeating the build three times).
    "no-vite": { type: "boolean", default: false },
    metafile: { type: "string" },
  },
});

const entrypoint = "src/server-entry.ts";

function failOnLogs(result: Bun.BuildOutput, label: string): void {
  if (result.success) {
    return;
  }
  console.error(`${label} failed`);
  for (const msg of result.logs) {
    console.error(msg);
  }
  process.exit(1);
}

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

// ── Step 2a: JS bundle ──────────────────────────────────────────────────────

if (values.bundle) {
  const outdir = "build";
  rmSync(outdir, { recursive: true, force: true });
  const bundleResult = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    naming: { entry: "index.js" },
    target: "bun",
    minify: true,
  });
  failOnLogs(bundleResult, "Bundle");
  console.log(`Done: ${outdir}/index.js`);
  process.exit(0);
}

// ── Step 2b: Compile to standalone binary ───────────────────────────────────

const target = values.target!;
const outfile = values.outfile!;

console.log(`Building ${outfile} for ${target}…`);

// compile mode derives the output filename from the entrypoint path, ignoring
// naming/outfile options. Output to a temp dir then rename to the desired name.
const tmpDir = await import("node:os").then((os) => os.tmpdir());
const tmpOut = `${tmpDir}/bun-dashboard-compile-${Date.now()}`;

const buildResult = await Bun.build({
  entrypoints: [entrypoint],
  outdir: tmpOut,
  compile: true,
  minify: true,
  target: target as Parameters<typeof Bun.build>[0]["target"],
  metafile: values.metafile !== undefined,
});
failOnLogs(buildResult, "Compile");

if (values.metafile) {
  await Bun.write(values.metafile, JSON.stringify(buildResult.metafile));
}

// Rename the compiled binary from its auto-derived name to the desired outfile.
const [compiledOutput] = buildResult.outputs;
if (!compiledOutput) {
  console.error("Compile succeeded but produced no outputs");
  process.exit(1);
}
await $`mv ${compiledOutput.path} ${outfile} && chmod +x ${outfile}`;

console.log(`Done: ${outfile} (${target})`);
