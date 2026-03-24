import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const START_MARKER =
  "# [sync:workspace-manifests] - auto-generated, do not edit";
const END_MARKER = "# [/sync:workspace-manifests]";

// Discover workspace packages that have a package.json
const packages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() &&
      existsSync(join(PACKAGES_DIR, d.name, "package.json")),
  )
  .map((d) => d.name)
  .sort();

// Generate the COPY block
const copyLines = [
  START_MARKER,
  "COPY package.json bun.lock ./",
  ...packages.map(
    (p) => `COPY packages/${p}/package.json packages/${p}/package.json`,
  ),
  END_MARKER,
];
const block = copyLines.join("\n");

// Find all Dockerfiles in package directories
const dockerfiles = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(PACKAGES_DIR, d.name, "Dockerfile"))
  .filter((f) => existsSync(f));

const isCheck = process.argv.includes("--check");
let dirty = false;

for (const df of dockerfiles) {
  const content = readFileSync(df, "utf-8");
  const rel = relative(ROOT, df);

  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    console.error(`Missing sync markers in ${rel}`);
    process.exit(1);
  }

  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + END_MARKER.length);
  const updated = before + block + after;

  if (content !== updated) {
    if (isCheck) {
      console.error(`OUT OF DATE: ${rel}`);
      dirty = true;
    } else {
      writeFileSync(df, updated);
      console.log(`Updated: ${rel}`);
    }
  } else {
    console.log(`OK: ${rel}`);
  }
}

if (isCheck && dirty) {
  console.error("\nRun 'bun run sync:dockerfiles' to fix.");
  process.exit(1);
}
