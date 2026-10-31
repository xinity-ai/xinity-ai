#!/usr/bin/env bun
// Combines the per-binary SBOMs of generate-sbom.ts into one release SBOM.
// Libraries shared by several binaries are listed once, the dependency graph
// records which binary bundles which library.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

type Component = { "bom-ref": string };
type Dependency = { ref: string; dependsOn: string[] };
type Bom = {
  metadata: { component: Component & { version: string } };
  components: Component[];
  dependencies: Dependency[];
};

const { values, positionals: binaryBomFiles } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    version: { type: "string" },
    out: { type: "string" },
  },
});

if (!values.version || !values.out || binaryBomFiles.length === 0) {
  console.error("usage: combine-sbom.ts --version <x.y.z> --out <file.cdx.json> <binary sbom>...");
  process.exit(2);
}

const binaryBoms: Bom[] = binaryBomFiles.map((file) => JSON.parse(readFileSync(file, "utf8")));
const binaries = binaryBoms.map((bom) => bom.metadata.component);

const libraries = new Map<string, Component>();
for (const bom of binaryBoms) {
  for (const component of bom.components) {
    libraries.set(component["bom-ref"], component);
  }
}

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      "bom-ref": "xinity",
      name: "xinity",
      version: values.version,
      supplier: { name: "Xinity AI" },
    },
  },
  components: [...binaries, ...[...libraries.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]))],
  dependencies: [
    { ref: "xinity", dependsOn: binaries.map((binary) => binary["bom-ref"]) },
    ...binaryBoms.flatMap((binaryBom) => binaryBom.dependencies),
  ],
};

writeFileSync(values.out, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`${values.out}: ${binaries.length} binaries, ${libraries.size} libraries`);
