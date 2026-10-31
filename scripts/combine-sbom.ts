#!/usr/bin/env bun
// Combines the SBOMs of the release's binaries and container images into one.
// Packages shared by several of them are listed once, the dependency graph
// records which binary or image contains which package.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

type Component = { "bom-ref": string };
type Dependency = { ref: string; dependsOn: string[] };
type Bom = {
  metadata: { component: Component };
  components: Component[];
  dependencies: Dependency[];
};

const { values, positionals: deliverableBomFiles } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    version: { type: "string" },
    out: { type: "string" },
  },
});

if (!values.version || !values.out || deliverableBomFiles.length === 0) {
  console.error("usage: combine-sbom.ts --version <x.y.z> --out <file.cdx.json> <binary or image sbom>...");
  process.exit(2);
}

const deliverableBoms: Bom[] = deliverableBomFiles.map((file) => JSON.parse(readFileSync(file, "utf8")));
const deliverables = deliverableBoms.map((bom) => bom.metadata.component);

const packages = new Map<string, Component>();
for (const bom of deliverableBoms) {
  for (const component of bom.components) {
    packages.set(component["bom-ref"], component);
  }
}

const releasePurl = `pkg:github/xinity-ai/xinity-ai@v${values.version}`;

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      "bom-ref": releasePurl,
      name: "xinity",
      version: values.version,
      purl: releasePurl,
      supplier: { name: "Xinity AI" },
    },
  },
  components: [...deliverables, ...[...packages.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]))],
  dependencies: [
    { ref: releasePurl, dependsOn: deliverables.map((deliverable) => deliverable["bom-ref"]) },
    ...deliverableBoms.flatMap((deliverableBom) => deliverableBom.dependencies),
  ],
};

writeFileSync(values.out, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`${values.out}: ${deliverables.length} binaries and images, ${packages.size} packages`);
