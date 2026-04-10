/**
 * Build a component binary from a local monorepo checkout and package it
 * as a zip archive ready for installation via installBinary().
 */
import { resolve, join } from "path";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { $ } from "bun";
import * as p from "./clack.ts";
import { fail, pass } from "./output.ts";
import { binaryBaseName, type Component } from "./component-meta.ts";

const BUILDABLE_COMPONENTS = ["daemon", "gateway", "dashboard", "infoserver"] as const;
type BuildableComponent = (typeof BUILDABLE_COMPONENTS)[number];

function isBuildable(component: Component): component is BuildableComponent {
  return (BUILDABLE_COMPONENTS as readonly string[]).includes(component);
}

const PACKAGE_DIRS: Record<BuildableComponent, string> = {
  daemon: "packages/xinity-ai-daemon",
  gateway: "packages/xinity-ai-gateway",
  dashboard: "packages/xinity-ai-dashboard",
  infoserver: "packages/xinity-infoserver",
};

function buildCommand(component: BuildableComponent, arch: "x64" | "arm64"): string[] {
  const target = `bun-linux-${arch}`;
  const binName = binaryBaseName(component as Component);

  switch (component) {
    case "daemon":
      return ["bun", "build", "--compile", "--minify", `--target=${target}`, "./src/index.ts", "--outfile", binName];
    case "gateway":
      return ["bun", "build", "--compile", "--minify", `--target=${target}`, "./src/gatewayServer.ts", "--outfile", binName];
    case "infoserver":
      return ["bun", "build", "--compile", "--minify", `--target=${target}`, "./server.ts", "--outfile", binName];
    case "dashboard":
      return ["bun", "run", "build.ts", "--target", target, "--outfile", binName];
  }
}

async function readVersion(repoPath: string): Promise<string> {
  try {
    const pkgJson = await Bun.file(join(repoPath, "package.json")).json();
    if (typeof pkgJson.version === "string") return pkgJson.version;
  } catch {
    // fall through
  }
  try {
    const result = await $`git -C ${repoPath} rev-parse --short HEAD`.quiet();
    if (result.exitCode === 0) return result.stdout.toString().trim();
  } catch {
    // fall through
  }
  return "local";
}

export async function buildLocalArtifact(
  component: Component,
  repoPath: string,
  targetArch: "x64" | "arm64",
): Promise<{ archivePath: string; version: string; sha256: string } | null> {
  if (!isBuildable(component)) {
    fail("Local build", `${component} does not support local builds (only: ${BUILDABLE_COMPONENTS.join(", ")})`);
    return null;
  }

  const absRepoPath = resolve(repoPath);
  if (!existsSync(absRepoPath)) {
    fail("Local build", `Directory not found: ${absRepoPath}`);
    return null;
  }

  const pkgDir = join(absRepoPath, PACKAGE_DIRS[component]);
  if (!existsSync(pkgDir)) {
    fail("Local build", `Package directory not found: ${pkgDir}`);
    return null;
  }

  const cmd = buildCommand(component, targetArch);
  const binName = binaryBaseName(component as Component);
  const binPath = join(pkgDir, binName);

  const spinner = p.spinner();
  spinner.start(`Building ${component} for linux/${targetArch}...`);

  const result = await $`${cmd}`.cwd(pkgDir).nothrow().quiet();
  if (result.exitCode !== 0) {
    spinner.stop("Build failed");
    const stderr = result.stderr.toString().trim();
    if (stderr) fail("Build", stderr);
    return null;
  }

  if (!existsSync(binPath)) {
    spinner.stop("Build failed");
    fail("Local build", `Expected binary not found after build: ${binPath}`);
    return null;
  }

  spinner.stop(`Built ${binName}`);

  // Package into zip (matches the format installBinary() expects)
  const tmpZip = join(tmpdir(), `xinity-local-${component}-${Date.now()}.zip`);
  const zipSpinner = p.spinner();
  zipSpinner.start("Packaging...");

  const zipResult = await $`zip -j ${tmpZip} ${binPath}`.nothrow().quiet();
  if (zipResult.exitCode !== 0) {
    zipSpinner.stop("Packaging failed");
    fail("Zip", zipResult.stderr.toString().trim());
    return null;
  }
  zipSpinner.stop("Packaged");

  // Compute SHA256 of the zip
  const hasher = new Bun.CryptoHasher("sha256");
  const zipBytes = await Bun.file(tmpZip).arrayBuffer();
  hasher.update(zipBytes);
  const sha256 = hasher.digest("hex");

  const version = await readVersion(absRepoPath);
  const versionString = `local-${version}`;

  pass("Local build", `${component} ${versionString} (${targetArch})`);
  return { archivePath: tmpZip, version: versionString, sha256 };
}
