import type { CommandModule } from "yargs";
import { confirm, intro, isCancel, log, note, outro } from "../lib/core/clack.ts";
import { bold, cyan, dim, yellow } from "picocolors";
import { type Component, ENV_DIR } from "../lib/core/component-meta.ts";
import { discoverConnectionUrl } from "../lib/up/migrator.ts";
import {
  planUp,
  renderUpPlan,
  renderUpPlanScript,
  reviewGate,
  applyUpPlan,
  printPostInstallSummary,
  type UpPlan,
} from "../lib/up/up-plan.ts";
import { warn, heading } from "../lib/core/output.ts";
import { connectHost, TARGET_HOST_OPTION } from "../lib/remote/remote-host.ts";
import { type Host, commandExistsOn } from "../lib/core/host.ts";
import { parseEnvString } from "../lib/config/env-file.ts";
import { seaweedfsSetup } from "../lib/infra/seaweedfs-setup.ts";
import { IN_PROCESS_CACHE, infraRedis, planRedis } from "../lib/infra/redis-setup.ts";
import { postgresSetup } from "../lib/infra/postgres-setup.ts";
import { ollamaSetup } from "../lib/infra/ollama-setup.ts";
import { prometheusSetup } from "../lib/infra/prometheus-setup.ts";
import { searxngSetup } from "../lib/infra/searxng-setup.ts";
import { runUpdateFlow } from "./update.ts";

const COMPONENTS = [
  "gateway", "dashboard", "daemon", "infoserver", "tether",
  "db",
  "infra-redis", "infra-seaweedfs", "infra-postgres",
  "infra-ollama", "infra-vllm", "infra-searxng", "infra-prometheus",
  "cli", "all",
] as const;

const INFRA_SETUPS: Partial<Record<string, (host: Host, dryRun: boolean) => Promise<unknown>>> = {
  "infra-seaweedfs": seaweedfsSetup,
  "infra-prometheus": prometheusSetup,
  "infra-postgres": postgresSetup,
  "infra-ollama": ollamaSetup,
  "infra-searxng": searxngSetup,
};

type PreflightIssue = {
  tool: string;
  reason: string;
  hint?: string;
}

/**
 * Check all tool requirements upfront for the given components.
 * Returns a list of missing tools with install hints.
 * Deduplicates across components so each tool is only reported once.
 */
async function preflightCheck(
  components: readonly string[],
  host: Host,
): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];
  const checked = new Set<string>();

  const check = async (tool: string, reason: string, hint?: string) => {
    if (checked.has(tool)) return;
    checked.add(tool);
    if (!(await commandExistsOn(host, tool))) {
      issues.push({ tool, reason, hint });
    }
  };

  // systemd is required for any service component
  const serviceComponents: string[] = ["gateway", "dashboard", "daemon", "infoserver", "tether"];
  if (components.some((c) => serviceComponents.includes(c) || c === "all")) {
    await check("systemctl", "systemd is required to manage services");
  }

  const needsExtractor = components.some(
    (c) => c === "all" || serviceComponents.includes(c),
  );
  if (needsExtractor) {
    await check("tar", "required on the target host for binary extraction", "apt install tar / dnf install tar / pacman -S tar");
  }

  if (components.some((c) => serviceComponents.includes(c) || c === "all" || c === "db")) {
    await check("curl", "required on the target host for downloading release assets");
  }

  return issues;
}

/** Show onboarding hints after a dashboard install. */
async function showDashboardHints(host: Host): Promise<void> {
  const dashContent = await host.readFile(`${ENV_DIR}/dashboard.env`);
  const origin = dashContent ? parseEnvString(dashContent).ORIGIN : undefined;

  const lines: string[] = [];
  if (origin) {
    lines.push(`Dashboard:  ${cyan(origin)}`);
    lines.push("");
    lines.push(bold("Next steps:"));
    lines.push(`  1. Connect the CLI to your dashboard:`);
    lines.push(`     ${cyan(`xinity configure dashboardUrl ${origin}`)}`);
    lines.push(`  2. Create your admin account from the CLI:`);
    lines.push(`     ${cyan("xinity act onboarding.cli")}`);
    lines.push(`     Or open ${cyan(origin)} in a browser to sign up there.`);
  } else {
    lines.push(bold("Next steps:"));
    lines.push(`  1. Create your admin account via the dashboard UI`);
    lines.push(`     Or from the CLI: ${cyan("xinity act onboarding.cli")}`);
  }

  note(lines.join("\n"), "Dashboard installed");
}

async function reviewAndApply(plan: UpPlan, dryRun: boolean, host: Host): Promise<"applied" | "stopped" | "failed"> {
  renderUpPlan(plan);

  if (dryRun) {
    log.info(yellow("Dry run, stopping before apply."));
    return "stopped";
  }

  if (!(await reviewGate(() => renderUpPlanScript(plan)))) return "stopped";

  const result = await applyUpPlan(plan, host);
  if (!result.success) {
    for (const err of result.errors) log.error(err);
    return "failed";
  }
  return "applied";
}

async function runDbFlow(opts: { targetVersion: string; dryRun: boolean }, host: Host): Promise<boolean> {
  const dbPlan = await discoverConnectionUrl(host);
  if (!dbPlan) return false;

  heading("redis");
  const planned = await planRedis(host, { offerInProcess: true });
  const redisPlan = planned === IN_PROCESS_CACHE ? undefined : planned;
  if (!planned) {
    warn("Redis", "No Redis URL configured (can be set up later with xinity up infra-redis)");
  }

  const plan: UpPlan = {
    targetVersion: opts.targetVersion,
    provisionPostgres: dbPlan.provision,
    migrations: { connectionUrl: dbPlan.connectionUrl },
    redis: redisPlan?.persist || redisPlan?.provision ? redisPlan : undefined,
    components: [],
  };
  return (await reviewAndApply(plan, opts.dryRun, host)) !== "failed";
}

async function runPlannedFlow(
  component: string,
  opts: { targetVersion: string; dryRun: boolean; hardReset: boolean },
  host: Host,
): Promise<boolean> {
  const isAll = component === "all";

  const plan = await planUp(
    isAll ? [] : [component as Component],
    { targetVersion: opts.targetVersion, hardReset: opts.hardReset, dryRun: opts.dryRun, withInfra: isAll },
    host,
  );
  if (!plan) return true;

  const outcome = await reviewAndApply(plan, opts.dryRun, host);
  if (outcome !== "applied") return outcome === "stopped";

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

      const infraSetup = INFRA_SETUPS[component];
      if (infraSetup) {
        await infraSetup(host, dryRun);
        outro("Done");
        return;
      }

      if (component === "infra-vllm") {
        log.warn(`${cyan(component)} is not yet implemented.`);
        outro("Coming soon");
        return;
      }

      const ok = await runPlannedFlow(component, { targetVersion, dryRun, hardReset }, host);
      if (ok && !dryRun) {
        const target = targetHostArg ? ` --target-host ${targetHostArg}` : "";
        log.info(`Everything else is tunable with ${cyan(`xinity configure ${component}${target}`)}`);
      }
      outro(ok ? "Done" : "Failed");
      if (!ok) {
        process.exit(1);
      }
    } finally {
      await host.dispose();
    }
  },
};
