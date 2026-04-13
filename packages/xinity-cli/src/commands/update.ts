import type { CommandModule } from "yargs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { mkdirSync, copyFileSync, renameSync, unlinkSync, chmodSync, existsSync } from "fs";
import * as p from "../lib/clack.ts";
import pc from "picocolors";

import { version } from "../../../../package.json";
const CLI_VERSION = `v${version}`;
import { fetchRelease, getAssetName, type Release } from "../lib/github.ts";
import { downloadAndVerify } from "../lib/installer.ts";
import { pass, fail } from "../lib/output.ts";
import { createLocalHost } from "../lib/host.ts";

// ─── Self-update ────────────────────────────────────────────────────────────

async function selfUpdate(release: Release): Promise<boolean> {
  const assetName = getAssetName("cli");

  const tmpDir = join(tmpdir(), `xinity-cli-update-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const filePath = await downloadAndVerify(release, assetName, tmpDir);
  if (!filePath) return false;

  // Extract zip
  const extractDir = join(tmpDir, "extracted");
  mkdirSync(extractDir, { recursive: true });
  const local = createLocalHost();
  const unzip = await local.run(["unzip", "-o", filePath, "-d", extractDir]);
  if (!unzip.ok) {
    fail("Extract", "Failed to extract zip archive");
    return false;
  }

  // Detect the running binary path. In compiled mode process.execPath IS the binary.
  // Fall back to the conventional install location for dev/test environments.
  const fallbackPath = join(homedir(), ".local", "bin", "xinity");
  const execPath = process.execPath;
  const currentPath = existsSync(execPath) && execPath === process.argv[0] ? execPath
    : existsSync(fallbackPath) ? fallbackPath
    : null;

  if (!currentPath) {
    fail(
      "Self-update",
      `Could not locate the xinity binary to replace.\n` +
      `Expected it at ${pc.cyan(fallbackPath)} (conventional install location).\n` +
      `If you installed it elsewhere, replace the binary manually with the downloaded file.`,
    );
    return false;
  }

  const newBinary = join(extractDir, "xinity");
  const backupPath = currentPath + ".bak";

  const spinner2 = p.spinner();
  spinner2.start("Replacing binary…");

  try {
    chmodSync(newBinary, 0o755);

    // On Linux, renaming a running binary is safe (old inode stays alive until process exits)
    renameSync(currentPath, backupPath);
    try {
      copyFileSync(newBinary, currentPath);
      chmodSync(currentPath, 0o755);
      unlinkSync(backupPath);
    } catch (err) {
      // Rollback on failure
      renameSync(backupPath, currentPath);
      throw err;
    }

    spinner2.stop("Binary replaced");
    pass("Self-update", `Updated CLI to ${release.tagName}`);
    return true;
  } catch (err) {
    spinner2.stop("Replace failed");
    fail("Self-update", (err as Error).message);
    return false;
  }
}

// ─── Shared update flow ─────────────────────────────────────────────────────

export async function runUpdateFlow(opts: { checkOnly: boolean; targetVersion: string }): Promise<void> {
  const { checkOnly, targetVersion } = opts;

  p.intro(`xinity update${checkOnly ? pc.yellow(" (check only)") : ""}`);

  // Fetch latest release
  const spinner = p.spinner();
  spinner.start("Checking for updates…");

  let release: Release;
  try {
    release = await fetchRelease(targetVersion);
  } catch (err) {
    spinner.stop("Failed");
    fail("GitHub API", (err as Error).message);
    p.outro("Done");
    return;
  }
  spinner.stop(`Latest release: ${release.tagName}`);

  // Compare versions
  const needsUpdate = CLI_VERSION !== release.tagName && CLI_VERSION !== "dev";
  const status = needsUpdate
    ? pc.yellow(`${CLI_VERSION} → ${release.tagName}`)
    : pc.green(`${CLI_VERSION} (up to date)`);
  p.log.info(`  ${pc.cyan("cli")}  ${status}`);

  if (!needsUpdate) {
    p.log.success("Already up to date");
    p.outro("Done");
    return;
  }

  if (checkOnly) {
    p.outro("Run " + pc.cyan("xinity update") + " to apply the update");
    return;
  }

  // Confirm
  const proceed = await p.confirm({
    message: `Update CLI to ${release.tagName}?`,
    initialValue: true,
  });
  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Cancelled.");
    return;
  }

  await selfUpdate(release);
  p.outro("Done");
}

// ─── Command ────────────────────────────────────────────────────────────────

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
