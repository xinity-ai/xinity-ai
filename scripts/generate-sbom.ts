#!/usr/bin/env bun
// Writes a CycloneDX SBOM listing the packages that a build bundled.
// Inputs are Bun metafiles (paths relative to the working directory) or plain JSON arrays of absolute module paths. 
// The lockfile scan alone cannot tell which workspace dependencies end up in which binary, the bundler's module graph can.

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

type LockEntry = [spec: string, registry: string, info: object, integrity?: string];

type Component = {
  type: "library";
  "bom-ref": string;
  name: string;
  version: string;
  purl: string;
  licenses?: { expression: string }[];
  hashes?: { alg: string; content: string }[];
};

const { values, positionals: moduleLists } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    name: { type: "string" },
    version: { type: "string" },
    out: { type: "string" },
  },
});

if (!values.name || !values.version || !values.out || moduleLists.length === 0) {
  console.error("usage: generate-sbom.ts --name <package> --version <x.y.z> --out <file.cdx.json> <module list>...");
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "..");
const lockfile = Bun.JSONC.parse(readFileSync(join(repoRoot, "bun.lock"), "utf8")) as {
  packages: Record<string, LockEntry>;
};

function readModulePaths(file: string): string[] {
  const parsed: string[] | Bun.BuildMetafile = JSON.parse(readFileSync(file, "utf8"));
  const paths = Array.isArray(parsed) ? parsed : Object.keys(parsed.inputs);
  return paths.map((path) => resolve(path));
}

// "/r/node_modules/a/node_modules/@s/b/x.js" -> dir "/r/node_modules/a/node_modules/@s/b", lock key "a/@s/b"
function packageOf(modulePath: string): { dir: string; lockKey: string } | undefined {
  const segments = modulePath.split("/");
  const nameChain: string[] = [];
  let end = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] !== "node_modules") {
      continue;
    }
    const nameLength = segments[i + 1]?.startsWith("@") ? 2 : 1;
    nameChain.push(segments.slice(i + 1, i + 1 + nameLength).join("/"));
    end = i + 1 + nameLength;
  }
  if (end < 0) {
    return undefined;
  }
  return { dir: segments.slice(0, end).join("/"), lockKey: nameChain.join("/") };
}

function licenseOf(manifest: { license?: string | { type?: string } }): string | undefined {
  return typeof manifest.license === "string" ? manifest.license : manifest.license?.type;
}

// Integrity strings are "sha512-<base64>", CycloneDX wants hex.
function hashesOf(integrity: string | undefined): Component["hashes"] {
  const match = integrity?.match(/^sha512-(.+)$/);
  if (!match?.[1]) {
    return undefined;
  }
  return [{ alg: "SHA-512", content: Buffer.from(match[1], "base64").toString("hex") }];
}

function purlOf(name: string, version: string): string {
  return `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
}

const components = new Map<string, Component>();
for (const list of moduleLists) {
  for (const modulePath of readModulePaths(list)) {
    const pkg = packageOf(modulePath);
    if (!pkg) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8"));
    const purl = purlOf(manifest.name, manifest.version);
    if (components.has(purl)) {
      continue;
    }
    const license = licenseOf(manifest);
    const hashes = hashesOf(lockfile.packages[pkg.lockKey]?.[3]);
    components.set(purl, {
      type: "library",
      "bom-ref": purl,
      name: manifest.name,
      version: manifest.version,
      purl,
      ...(license && { licenses: [{ expression: license }] }),
      ...(hashes && { hashes }),
    });
  }
}

// Compiled binaries embed the Bun runtime that built them.
const bunPurl = `pkg:github/oven-sh/bun@bun-v${Bun.version}`;
components.set(bunPurl, {
  type: "library",
  "bom-ref": bunPurl,
  name: "bun",
  version: Bun.version,
  purl: bunPurl,
  licenses: [{ expression: "MIT" }],
});

const sortedComponents = [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl));
const binaryPurl = `pkg:github/xinity-ai/xinity-ai@v${values.version}#${relative(repoRoot, process.cwd())}`;
const binaryLicense = licenseOf(JSON.parse(readFileSync("package.json", "utf8")));

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      "bom-ref": binaryPurl,
      name: values.name,
      version: values.version,
      purl: binaryPurl,
      ...(binaryLicense && { licenses: [{ expression: binaryLicense }] }),
      supplier: { name: "Xinity AI" },
    },
  },
  components: sortedComponents,
  dependencies: [{ ref: binaryPurl, dependsOn: sortedComponents.map((c) => c["bom-ref"]) }],
};

writeFileSync(values.out, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`${values.out}: ${sortedComponents.length} components`);
