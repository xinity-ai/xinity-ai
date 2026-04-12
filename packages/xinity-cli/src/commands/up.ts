import type { CommandModule } from "yargs";
import * as p from "../lib/clack.ts";
import pc from "picocolors";
import { installComponent, installAll, preflightCheck, showDashboardHints } from "../lib/installer.ts";
import type { Component } from "../lib/component-meta.ts";
import { runMigrations } from "../lib/migrator.ts";
import { logErrors, warn } from "../lib/output.ts";
import { createLocalHost } from "../lib/host.ts";
import { connectRemoteHost } from "../lib/remote-host.ts";
import { seaweedfsSetup } from "../lib/seaweedfs-setup.ts";
import { infraRedis } from "../lib/redis-setup.ts";
import { runUpdateFlow } from "./update.ts";

const COMPONENTS = [
  // Core application components
  "gateway", "dashboard", "daemon", "infoserver",
  // Shared infrastructure (Postgres migrations + Redis discovery)
  "db",
  // Infrastructure utilities
  "infra-redis", "infra-seaweedfs", "infra-postgres",
  "infra-ollama", "infra-vllm", "infra-searxng",
  // Meta
  "cli", "all",
] as const;

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

    try {
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

      if (component === "cli") {
        await runUpdateFlow({ checkOnly: false, targetVersion });
        return;
      }

      if (component === "db") {
        const result = await runMigrations({ targetVersion, dryRun, host });
        logErrors(result);
        p.outro("Done");
        return;
      }

      if (component === "infra-redis") {
        const url = await infraRedis(host, dryRun);
        if (url) {
          p.log.success("Redis connection configured.");
        } else {
          warn("Redis", "No Redis URL configured");
        }
        p.outro("Done");
        return;
      }

      if (component === "infra-seaweedfs") {
        await seaweedfsSetup(host, dryRun);
        p.outro("Done");
        return;
      }

      if (component === "infra-postgres") {
        const { postgresSetup } = await import("../lib/postgres-setup.ts");
        await postgresSetup(host, dryRun);
        p.outro("Done");
        return;
      }

      if (
        component === "infra-ollama" ||
        component === "infra-vllm" ||
        component === "infra-searxng"
      ) {
        p.log.warn(`${pc.cyan(component)} is not yet implemented.`);
        p.outro("Coming soon");
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

      if (component === "dashboard" && result.success && !dryRun) {
        await showDashboardHints(host);
      }

      p.outro("Done");
    } finally {
      await host.dispose();
    }
  },
};
