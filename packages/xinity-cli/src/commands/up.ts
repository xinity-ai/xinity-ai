import type { CommandModule } from "yargs";
import * as p from "../lib/clack.ts";
import pc from "picocolors";
import { installComponent, installAll, preflightCheck, type Component } from "../lib/installer.ts";
import { runMigrations } from "../lib/migrator.ts";
import { logErrors, warn } from "../lib/output.ts";
import { createLocalHost } from "../lib/host.ts";
import { connectRemoteHost } from "../lib/remote-host.ts";
import { seaweedfsSetup } from "../lib/seaweedfs-setup.ts";
import { discoverRedisUrl } from "../lib/redis-setup.ts";

const COMPONENTS = ["gateway", "dashboard", "daemon", "infoserver", "db", "redis", "seaweedfs", "all"] as const;

export const upCommand: CommandModule = {
  command: "up <component>",
  describe: "Install or update a Xinity service component",
  builder: (yargs) =>
    yargs
      .positional("component", {
        describe: "Component to install/update",
        type: "string",
        choices: [...COMPONENTS],
        demandOption: true,
      })
      .option("target-version", {
        describe: "Version to install (tag name or 'latest')",
        type: "string",
        default: "latest",
      })
      .option("dry-run", {
        describe: "Show what would be done without making changes",
        type: "boolean",
        default: false,
      })
      .option("hard-reset", {
        describe: "Fully reset component state during reinstall (systemctl clean --what=state)",
        type: "boolean",
        default: false,
      }),
  handler: async (argv) => {
    const component = argv.component as string;
    const targetVersion = argv["target-version"] as string;
    const dryRun = argv["dry-run"] as boolean;
    const hardReset = argv["hard-reset"] as boolean;
    const targetHostArg = argv["target-host"] as string | undefined;

    p.intro(`xinity up ${pc.cyan(component)}${dryRun ? pc.yellow(" (dry run)") : ""}${targetHostArg ? pc.dim(` → ${targetHostArg}`) : ""}`);

    const host = targetHostArg ? await connectRemoteHost(targetHostArg) : createLocalHost();

    // ── Upfront pre-flight checks ──────────────────────────────────────
    const issues = await preflightCheck([component], host);
    if (issues.length > 0) {
      p.log.step(pc.bold("Pre-flight checks"));
      for (const issue of issues) {
        warn(issue.tool, issue.reason);
        if (issue.hint) p.log.info(`  ${pc.dim("Install:")} ${pc.cyan(issue.hint)}`);
      }
      const cont = await p.confirm({
        message: "Some requirements are missing. Continue anyway?",
        initialValue: false,
      });
      if (p.isCancel(cont) || !cont) {
        p.outro("Aborted");
        return;
      }
    }

    if (component === "db") {
      const result = await runMigrations({ targetVersion, dryRun, host });
      logErrors(result);
      p.outro("Done");
      return;
    }

    if (component === "redis") {
      await discoverRedisUrl(host, dryRun);
      p.outro("Done");
      return;
    }

    if (component === "seaweedfs") {
      await seaweedfsSetup(host, dryRun);
      p.outro("Done");
      return;
    }

    if (component === "all") {
      await installAll(targetVersion, dryRun, hardReset, host);
      p.outro("Done");
      return;
    }

    const result = await installComponent({
      component: component as Component,
      targetVersion,
      dryRun,
      hardReset,
      host,
    });

    logErrors(result);
    p.outro("Done");
  },
};
