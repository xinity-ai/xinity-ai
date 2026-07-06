import { resolve, join, dirname, basename } from "path";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { $ } from "bun";
import { binaryBaseName, type Component } from "./component-meta.ts";
import type { StepEvent } from "./step-event.ts";

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

const BUN_BUILD_ENTRYPOINTS: Record<Exclude<BuildableComponent, "dashboard">, string> = {
  daemon: "./src/index.ts",
  gateway: "./src/gatewayServer.ts",
  infoserver: "./server.ts",
};

function buildCommand(component: BuildableComponent, arch: "x64" | "arm64"): string[] {
  const target = `bun-linux-${arch}`;
  const binName = binaryBaseName(component);

  if (component === "dashboard") {
    return ["bun", "run", "build.ts", "--target", target, "--outfile", binName];
  }
  return ["bun", "build", "--compile", "--minify", `--target=${target}`, BUN_BUILD_ENTRYPOINTS[component], "--outfile", binName];
}

async function readVersion(repoPath: string): Promise<string> {
  try {
    const pkgJson = await Bun.file(join(repoPath, "package.json")).json();
    if (typeof pkgJson.version === "string") {
      return pkgJson.version;
    }
  } catch {
    // fall through
  }
  try {
    const result = await $`git -C ${repoPath} rev-parse --short HEAD`.quiet();
    if (result.exitCode === 0) {
      return result.stdout.toString().trim();
    }
  } catch {
    // fall through
  }
  return "local";
}

export async function* buildLocalArtifact(
  component: Component,
  repoPath: string,
  targetArch: "x64" | "arm64",
): AsyncGenerator<StepEvent, { archivePath: string; version: string; sha256: string } | null> {
  if (!isBuildable(component)) {
    yield { type: "fail", label: "Local build", detail: `${component} does not support local builds (only: ${BUILDABLE_COMPONENTS.join(", ")})` };
    return null;
  }

  const absRepoPath = resolve(repoPath);
  if (!existsSync(absRepoPath)) {
    yield { type: "fail", label: "Local build", detail: `Directory not found: ${absRepoPath}` };
    return null;
  }

  const pkgDir = join(absRepoPath, PACKAGE_DIRS[component]);
  if (!existsSync(pkgDir)) {
    yield { type: "fail", label: "Local build", detail: `Package directory not found: ${pkgDir}` };
    return null;
  }

  const cmd = buildCommand(component, targetArch);
  const binName = binaryBaseName(component);
  const binPath = join(pkgDir, binName);

  yield { type: "spinner", id: "build", message: `Building ${component} for linux/${targetArch}...` };

  const result = await $`${cmd}`.cwd(pkgDir).nothrow().quiet();
  if (result.exitCode !== 0) {
    yield { type: "spinner", id: "build", message: "Build failed", done: true };
    const stderr = result.stderr.toString().trim();
    if (stderr) {
      yield { type: "fail", label: "Build", detail: stderr };
    }
    return null;
  }

  if (!existsSync(binPath)) {
    yield { type: "spinner", id: "build", message: "Build failed", done: true };
    yield { type: "fail", label: "Local build", detail: `Expected binary not found after build: ${binPath}` };
    return null;
  }

  yield { type: "spinner", id: "build", message: `Built ${binName}`, done: true };

  const tmpArchive = join(tmpdir(), `xinity-local-${component}-${Date.now()}.tar.gz`);
  yield { type: "spinner", id: "package", message: "Packaging..." };

  const tarResult = await $`tar -czf ${tmpArchive} -C ${dirname(binPath)} ${basename(binPath)}`.nothrow().quiet();
  if (tarResult.exitCode !== 0) {
    yield { type: "spinner", id: "package", message: "Packaging failed", done: true };
    yield { type: "fail", label: "Tar", detail: tarResult.stderr.toString().trim() };
    return null;
  }
  yield { type: "spinner", id: "package", message: "Packaged", done: true };

  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(tmpArchive).stream()) {
    hasher.update(chunk);
  }
  const sha256 = hasher.digest("hex");

  const version = await readVersion(absRepoPath);
  const versionString = `local-${version}`;

  yield { type: "pass", label: "Local build", detail: `${component} ${versionString} (${targetArch})` };
  return { archivePath: tmpArchive, version: versionString, sha256 };
}
