import type { CommandModule } from "yargs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, copyFileSync, renameSync, unlinkSync, chmodSync, existsSync } from "fs";
import { cancel, confirm, intro, isCancel, log, outro, spinner as clackSpinner } from "../lib/clack.ts";
import { cyan, green, yellow } from "picocolors";
import { defaultInstallDir, binaryName, IS_WINDOWS } from "../lib/platform.ts";

import { version } from "../../../../package.json";
const CLI_VERSION = `v${version}`;
import { fetchRelease, pickReleaseAsset, type Release } from "../lib/github.ts";
import { downloadAndVerify, extractCommandArgv } from "../lib/install-download.ts";
import { runSteps } from "../lib/step-runner.ts";
import { pass, fail } from "../lib/output.ts";
import { localRun } from "../lib/host.ts";

export function cleanupOldBinary(): void {
  if (!IS_WINDOWS) {
    return;
  }
  const execPath = process.execPath;
  const oldPath = execPath.replace(/\.exe$/i, ".old.exe");
  if (oldPath !== execPath && existsSync(oldPath)) {
    try {
      unlinkSync(oldPath);
    } catch {
      // Previous instance may still be exiting; ignore
    }
  }
}

async function selfUpdate(release: Release): Promise<boolean> {
  let assetName: string;
  try {
    assetName = pickReleaseAsset(release, "cli");
  } catch (err) {
    fail("Self-update", (err as Error).message);
    return false;
  }

  const tmpDir = join(tmpdir(), `xinity-cli-update-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const filePath = await runSteps(downloadAndVerify(release, assetName, tmpDir));
  if (!filePath) return false;

  const extractDir = join(tmpDir, "extracted");
  mkdirSync(extractDir, { recursive: true });
  const extracted = await localRun(extractCommandArgv(filePath, extractDir));
  if (!extracted.ok) {
    fail("Extract", "Failed to extract archive");
    return false;
  }

  const fallbackPath = join(defaultInstallDir(), binaryName());
  const currentPath = locateRunningBinary(fallbackPath);

  if (!currentPath) {
    fail(
      "Self-update",
      `Could not locate the xinity binary to replace.\n` +
      `Expected it at ${cyan(fallbackPath)} (conventional install location).\n` +
      `If you installed it elsewhere, replace the binary manually with the downloaded file.`,
    );
    return false;
  }

  const newBinary = join(extractDir, binaryName());

  const replaceSpinner = clackSpinner();
  replaceSpinner.start("Replacing binary…");

  try {
    if (!IS_WINDOWS) {
      chmodSync(newBinary, 0o755);
    }

    if (IS_WINDOWS) {
      // Windows allows renaming a running .exe but not deleting it.
      // Rename the current binary aside, copy the new one in, and let
      // cleanupOldBinary() remove the old file on the next invocation.
      const oldPath = currentPath.replace(/\.exe$/i, ".old.exe");
      renameSync(currentPath, oldPath);
      try {
        copyFileSync(newBinary, currentPath);
      } catch (err) {
        renameSync(oldPath, currentPath);
        throw err;
      }
    } else {
      const backupPath = currentPath + ".bak";
      renameSync(currentPath, backupPath);
      try {
        copyFileSync(newBinary, currentPath);
        chmodSync(currentPath, 0o755);
        unlinkSync(backupPath);
      } catch (err) {
        renameSync(backupPath, currentPath);
        throw err;
      }
    }

    replaceSpinner.stop("Binary replaced");
    pass("Self-update", `Updated CLI to ${release.tagName}`);
    return true;
  } catch (err) {
    replaceSpinner.stop("Replace failed");
    fail("Self-update", (err as Error).message);
    return false;
  }
}

function locateRunningBinary(fallbackPath: string): string | null {
  const execPath = process.execPath;
  if (existsSync(execPath) && execPath === process.argv[0]) return execPath;
  if (existsSync(fallbackPath)) return fallbackPath;
  return null;
}

export async function runUpdateFlow(opts: { checkOnly: boolean; targetVersion: string }): Promise<void> {
  const { checkOnly, targetVersion } = opts;

  intro(`xinity update${checkOnly ? yellow(" (check only)") : ""}`);

  const spinner = clackSpinner();
  spinner.start("Checking for updates…");

  let release: Release;
  try {
    release = await fetchRelease(targetVersion);
  } catch (err) {
    spinner.stop("Failed");
    fail("GitHub API", (err as Error).message);
    outro("Done");
    return;
  }
  spinner.stop(`Latest release: ${release.tagName}`);

  const needsUpdate = CLI_VERSION !== release.tagName;
  const status = needsUpdate
    ? yellow(`${CLI_VERSION} → ${release.tagName}`)
    : green(`${CLI_VERSION} (up to date)`);
  log.info(`  ${cyan("cli")}  ${status}`);

  if (!needsUpdate) {
    log.success("Already up to date");
    outro("Done");
    return;
  }

  if (checkOnly) {
    outro("Run " + cyan("xinity update") + " to apply the update");
    return;
  }

  const proceed = await confirm({
    message: `Update CLI to ${release.tagName}?`,
    initialValue: true,
  });
  if (isCancel(proceed) || !proceed) {
    cancel("Cancelled.");
    return;
  }

  const ok = await selfUpdate(release);
  if (!ok) {
    process.exit(1);
  }
  outro("Done");
}

export const updateCommand: CommandModule = {
  command: "update",
  describe: "Update the Xinity CLI to the latest version",
  builder: (yargs) =>
    yargs
      .option("check", {
        describe: "Only check for updates, don't install",
        type: "boolean",
        default: false,
      })
      .option("target-version", {
        describe: "Version to update to (tag name or 'latest')",
        type: "string",
        default: "latest",
      }),
  handler: async (argv) => {
    await runUpdateFlow({
      checkOnly: argv.check as boolean,
      targetVersion: argv["target-version"] as string,
    });
  },
};
