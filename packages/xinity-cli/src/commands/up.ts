import type { CommandModule } from "yargs";
import { confirm, intro, isCancel, log, outro } from "../lib/clack.ts";
import { bold, cyan, dim, yellow } from "picocolors";
import type { Component } from "../lib/component-meta.ts";
import { preflightCheck, showDashboardHints } from "../lib/installer.ts";
import { discoverConnectionUrl, describeMigrationStep, runMigrations } from "../lib/migrator.ts";
import {
  planUp,
  renderUpPlan,
  renderUpPlanScript,
  reviewGate,
  applyUpPlan,
  printPostInstallSummary,
} from "../lib/up-plan.ts";
import { warn, heading } from "../lib/output.ts";
import { connectHost, TARGET_HOST_OPTION } from "../lib/remote-host.ts";
import { seaweedfsSetup } from "../lib/seaweedfs-setup.ts";
import { infraRedis } from "../lib/redis-setup.ts";
import { runUpdateFlow } from "./update.ts";

const COMPONENTS = [
  // Core application components
  "gateway", "dashboard", "daemon", "infoserver", "tether",
  // Shared infrastructure (Postgres migrations + Redis discovery)
  "db",
  // Infrastructure utilities
  "infra-redis", "infra-seaweedfs", "infra-postgres",
  "infra-ollama", "infra-vllm", "infra-searxng", "infra-prometheus",
  // Meta
  "cli", "all",
] as const;

/** `up db`: plan (discover the URL), review, then provision/migrate and wire Redis. */
async function runDbFlow(opts: { targetVersion: string; dryRun: boolean }, host: import("../lib/host.ts").Host): Promise<boolean> {
  const dbPlan = await discoverConnectionUrl(host);
  if (!dbPlan) return false;

  log.step(bold("Planned actions"));
  let step = 1;
  if (dbPlan.provision) {
    const { describePostgresProvision } = await import("../lib/postgres-setup.ts");
    log.info(`${step++}. ${describePostgresProvision(dbPlan.provision)}`);
  }
  log.info(`${step}. ${describeMigrationStep(opts.targetVersion, dbPlan.connectionUrl)}`);

  if (opts.dryRun) {
    log.info(yellow("Dry run, stopping before apply."));
    return true;
  }
  if (!(await reviewGate())) return true;

  if (dbPlan.provision) {
    const { applyPostgresProvision } = await import("../lib/postgres-setup.ts");
    if (!(await applyPostgresProvision(dbPlan.provision, host))) return false;
  }

  const result = await runMigrations({ connectionUrl: dbPlan.connectionUrl, targetVersion: opts.targetVersion, dryRun: false, host });
  if (!result.success) {
    for (const err of result.errors) log.error(err);
    return false;
  }

  // Redis is a shared infrastructure dependency; non-fatal when skipped.
  heading("redis");
  const { planRedis, applyRedisPlan } = await import("../lib/redis-setup.ts");
  const redisPlan = await planRedis(host);
  if (redisPlan && (await applyRedisPlan(redisPlan, host))) {
    log.success("Redis - Connection configured");
  } else {
    warn("Redis", "No Redis URL configured (can be set up later with xinity up infra-redis)");
  }
  return true;
}

/** Service components and `all`: collect, review, gate, apply. */
async function runPlannedFlow(
  component: string,
  opts: { targetVersion: string; dryRun: boolean; hardReset: boolean },
  host: import("../lib/host.ts").Host,
): Promise<boolean> {
  const isAll = component === "all";
  if (isAll && opts.targetVersion.startsWith("local:")) {
    log.error("'xinity up all' does not support local: builds. Run 'xinity up <component>' for each component individually.");
    return false;
  }

  const plan = await planUp(
    isAll ? [] : [component as Component],
    { targetVersion: opts.targetVersion, hardReset: opts.hardReset, dryRun: opts.dryRun, withInfra: isAll },
    host,
  );
  if (!plan) return true;

  renderUpPlan(plan);

  if (opts.dryRun) {
    log.info(yellow("Dry run, stopping before apply."));
    return true;
  }

  if (!(await reviewGate(() => renderUpPlanScript(plan)))) return true;

  const result = await applyUpPlan(plan, host);
  if (!result.success) {
    for (const err of result.errors) log.error(err);
    return false;
  }

  if (isAll) {
    await printPostInstallSummary(host);
  } else if (component === "dashboard") {
    await showDashboardHints(host);
  }
  return true;
}

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
        describe: "Show the planned actions without applying them",
        type: "boolean",
        default: false,
      })
      .option("hard-reset", {
        describe: "Fully reset component state during reinstall (systemctl clean --what=state)",
        type: "boolean",
        default: false,
      })
      .option("target-host", TARGET_HOST_OPTION),
  handler: async (argv) => {
    const component = argv.component as string;
    const targetVersion = argv["target-version"] as string;
    const dryRun = argv["dry-run"] as boolean;
    const hardReset = argv["hard-reset"] as boolean;
    const targetHostArg = argv["target-host"] as string | undefined;

    if (component === "cli") {
      await runUpdateFlow({ checkOnly: false, targetVersion });
      return;
    }

    intro(`xinity up ${cyan(component)}${dryRun ? yellow(" (dry run)") : ""}${targetHostArg ? dim(` → ${targetHostArg}`) : ""}`);

    const host = await connectHost(targetHostArg);

    try {
      if (!(await host.prepareElevation())) {
        outro("Aborted");
        return;
      }

      // ── Upfront pre-flight checks ──────────────────────────────────────
      const issues = await preflightCheck([component], host);
      if (issues.length > 0) {
        log.step(bold("Pre-flight checks"));
        for (const issue of issues) {
          warn(issue.tool, issue.reason);
          if (issue.hint) log.info(`  ${dim("Install:")} ${cyan(issue.hint)}`);
        }
        const cont = await confirm({
          message: "Some requirements are missing. Continue anyway?",
          initialValue: false,
        });
        if (isCancel(cont) || !cont) {
          outro("Aborted");
          return;
        }
      }

      if (component === "db") {
        const ok = await runDbFlow({ targetVersion, dryRun }, host);
        outro(ok ? "Done" : "Failed");
        if (!ok) {
          process.exit(1);
        }
        return;
      }

      if (component === "infra-redis") {
        const url = await infraRedis(host, dryRun);
        if (url) {
          log.success("Redis connection configured.");
        } else {
          warn("Redis", "No Redis URL configured");
        }
        outro("Done");
        return;
      }

      if (component === "infra-seaweedfs") {
        await seaweedfsSetup(host, dryRun);
        outro("Done");
        return;
      }

      if (component === "infra-prometheus") {
        const { prometheusSetup } = await import("../lib/prometheus-setup.ts");
        await prometheusSetup(host, dryRun);
        outro("Done");
        return;
      }

      if (component === "infra-postgres") {
        const { postgresSetup } = await import("../lib/postgres-setup.ts");
        await postgresSetup(host, dryRun);
        outro("Done");
        return;
      }

      if (component === "infra-ollama") {
        const { ollamaSetup } = await import("../lib/ollama-setup.ts");
        await ollamaSetup(host, dryRun);
        outro("Done");
        return;
      }

      if (
        component === "infra-vllm" ||
        component === "infra-searxng"
      ) {
        log.warn(`${cyan(component)} is not yet implemented.`);
        outro("Coming soon");
        return;
      }

      const ok = await runPlannedFlow(component, { targetVersion, dryRun, hardReset }, host);
      outro(ok ? "Done" : "Failed");
      if (!ok) {
        process.exit(1);
      }
    } finally {
      await host.dispose();
    }
  },
};
