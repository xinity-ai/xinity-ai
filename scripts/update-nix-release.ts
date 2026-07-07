#!/usr/bin/env bun
// Rewrites nix/release.json against the SHASUMS256.txt of a given release tag.
// Preserves the existing package set: it looks up each package already declared
// under `bundles` and `binaries`, and fills in the SRI hashes for the new tag.
// Fails loudly if any expected artifact is missing from SHASUMS256.txt.

import { readFileSync, writeFileSync } from "node:fs";

type ReleaseInfo = {
  tag: string;
  version: string;
  bundles: Record<string, string>;
  binaries: Record<string, { "x86_64-linux": string; "aarch64-linux": string }>;
};

function parseArgs(): {
  tag: string;
  shasums: string;
  releaseJson: string;
} {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]?.replace(/^--/, "");
    const v = args[i + 1];
    if (!k || v === undefined) {
      throw new Error(`Bad arg at position ${i}: ${args[i]}`);
    }
    out[k] = v;
  }
  const tag = out.tag;
  const shasums = out.shasums;
  const releaseJson = out["release-json"];
  if (!tag || !shasums || !releaseJson) {
    console.error(
      "usage: update-nix-release.ts --tag <vX.Y.Z> --shasums <SHASUMS256.txt> --release-json <nix/release.json>",
    );
    process.exit(2);
  }
  return { tag, shasums, releaseJson };
}

function hexToSri(hex: string): string {
  const bytes = Buffer.from(hex.trim(), "hex");
  if (bytes.length !== 32) {
    throw new Error(`Expected 32 bytes of sha256, got ${bytes.length} from ${hex}`);
  }
  return `sha256-${bytes.toString("base64")}`;
}

function loadHashes(shasumsPath: string): Map<string, string> {
  const map = new Map<string, string>();
  const text = readFileSync(shasumsPath, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const [hex, name] = line.split(/\s+/);
    if (!hex || !name) {
      continue;
    }
    map.set(name, hexToSri(hex));
  }
  return map;
}

function lookup(hashes: Map<string, string>, file: string, label: string): string {
  const sri = hashes.get(file);
  if (!sri) {
    throw new Error(`SHASUMS256.txt is missing ${file} (needed for ${label})`);
  }
  return sri;
}

const { tag, shasums, releaseJson } = parseArgs();
const version = tag.startsWith("v") ? tag.slice(1) : tag;

const existing: ReleaseInfo = JSON.parse(readFileSync(releaseJson, "utf8"));
const hashes = loadHashes(shasums);

const next: ReleaseInfo = {
  tag,
  version,
  bundles: Object.fromEntries(
    Object.keys(existing.bundles ?? {})
      .sort()
      .map((pname) => [pname, lookup(hashes, `${pname}.js`, `bundles.${pname}`)] as const),
  ),
  binaries: Object.fromEntries(
    Object.keys(existing.binaries ?? {})
      .sort()
      .map(
        (pname) =>
          [
            pname,
            {
              "x86_64-linux": lookup(hashes, `${pname}-linux-x64.tar.gz`, `binaries.${pname}.x86_64-linux`),
              "aarch64-linux": lookup(hashes, `${pname}-linux-arm64.tar.gz`, `binaries.${pname}.aarch64-linux`),
            },
          ] as const,
      ),
  ),
};

writeFileSync(releaseJson, JSON.stringify(next, null, 2) + "\n");
console.log(`Updated ${releaseJson} -> ${tag}`);
