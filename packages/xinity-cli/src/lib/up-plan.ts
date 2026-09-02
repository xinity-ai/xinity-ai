/**
 * Planning and review phases of `xinity up` and `xinity configure`:
 * collect everything first (host state, versions, env values via the
 * familiar prompts) without touching the host, show the assembled actions,
 * gate on a single confirmation (with a bash-script dump as a secondary
 * option), then apply hands-off through the installer.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cancel, confirm, intro, isCancel, log, note, outro, select, spinner } from "./clack.ts";
import { bold, cyan, dim } from "picocolors";
import { type Component, ENV_SCHEMAS, ENV_DIR, getAutoDefaults, GATEWAY_DEFAULT_PORT, INFOSERVER_DEFAULT_PORT, TETHER_DEFAULT_PORT } from "./component-meta.ts";
import { type Host, isUnitActiveOn } from "./host.ts";
import { pass, fail, warn, heading } from "./output.ts";
import { parseEnvString } from "./env-file.ts";
import { unitName } from "./systemd.ts";
import { pickReleaseAsset, resolveDirectUrl, getProjectUrl, type Release } from "./github.ts";
import { assetSizeMb, buildInstallBinaryCommand } from "./install-download.ts";
import { buildEnvWriteCommand, buildSecretsWriteCommand, buildSecretsRemoveCommand, buildUnitWriteCommand, writeEnvConfig, writeSystemdUnit, restartService } from "./service.ts";
import { runSteps, createProgress } from "./step-runner.ts";
import { resolveVersion, applyComponentAction, type VersionResult } from "./installer.ts";
import { collectEnv, menuEditEnv, readExistingEnvState, diffEnv, planSecretFileRemoval, type EnvBundle, type EnvChange, type SecretFilePlan } from "./env-prompt.ts";
import { discoverConnectionUrl, describeMigrationStep, migrationScriptComment, runMigrations } from "./migrator.ts";
import { describePostgresProvision, buildPostgresProvisionCommands, applyPostgresProvision, type PostgresProvision } from "./postgres-setup.ts";
import { planRedis, applyRedisPlan, describeRedisPlan, buildRedisProvisionCommands, type RedisPlan } from "./redis-setup.ts";
import { readManifest } from "./manifest.ts";

export type ComponentActionKind = "install" | "update" | "reconfigure" | "none";

export type ComponentAction = {
  component: Component;
  kind: ComponentActionKind;
  installedVersion?: string;
  toVersion: string;
  release?: Release;
  localRepoPath?: string;
  localArchivePath?: string;
  assetName?: string;
  assetSizeMb?: string;
  env: EnvBundle;
  envChanges: EnvChange[];
  secretFiles: SecretFilePlan;
  hardReset: boolean;
  serviceRunning: boolean;
}

export type UpPlan = {
  targetVersion: string;
  provisionPostgres?: PostgresProvision;
  migrations?: { connectionUrl: string };
  redis?: RedisPlan;
  provisionOllama: boolean;
  components: ComponentAction[];
}

export type PlanUpOptions = {
  targetVersion: string;
  hardReset: boolean;
  dryRun: boolean;
  /** `up all`: resolve shared infrastructure (db, redis, optional ollama) first. */
  withInfra: boolean;
}

// ─── Collect ────────────────────────────────────────────────────────────────

/**
 * Assemble the action for a resolved version and collected env; the
 * single-host and stack planners differ only in how the env is collected.
 * Returns null when no matching release asset exists.
 */
export async function buildComponentAction(
  base: {
    component: Component;
    hardReset: boolean;
    serviceRunning: boolean;
    env: EnvBundle;
    envChanges: EnvChange[];
  },
  version: Extract<VersionResult, { status: "proceed" | "current" }>,
  host: Host,
): Promise<ComponentAction | null> {
  const secretFiles = await planSecretFileRemoval(base.component, base.envChanges, host);

  if (version.status === "current") {
    return {
      ...base,
      secretFiles,
      kind: base.envChanges.length > 0 ? "reconfigure" : "none",
      installedVersion: version.version,
      toVersion: version.version,
    };
  }

  let assetName: string;
  try {
    assetName = pickReleaseAsset(version.release, base.component, await host.getArch());
  } catch (err) {
    fail("Download", `${base.component}: ${(err as Error).message}`);
    return null;
  }
  const asset = version.release.assets.find((a) => a.name === assetName);

  return {
    ...base,
    secretFiles,
    kind: version.isUpdate ? "update" : "install",
    installedVersion: version.installedVersion,
    toVersion: version.release.tagName,
    release: version.release,
    assetName,
    assetSizeMb: asset ? assetSizeMb(asset) : undefined,
  };
}

/** Returns null when the user cancels or resolution fails. */
async function planComponentAction(
  component: Component,
  opts: PlanUpOptions,
  host: Host,
  shared: Record<string, string>,
  resolvedKeys: Set<string>,
): Promise<ComponentAction | null> {
  heading(component);

  const autoDefaults = { ...getAutoDefaults(component), ...shared };
  const base = {
    component,
    hardReset: opts.hardReset,
    serviceRunning: await isUnitActiveOn(host, unitName(component)),
  };

  if (opts.targetVersion.startsWith("local:")) {
    const collected = await collectEnv(component, host, autoDefaults, resolvedKeys);
    if (!collected) return null;
    const installed = (await readManifest(host)).components[component];
    return {
      ...base,
      kind: installed ? "update" : "install",
      installedVersion: installed?.version,
      toVersion: "local",
      localRepoPath: opts.targetVersion.slice(6),
      env: collected,
      envChanges: collected.changes,
      secretFiles: await planSecretFileRemoval(component, collected.changes, host),
    };
  }

  const version = await resolveVersion(component, opts.targetVersion, host);
  if (version.status === "failed") return null;

  const collected = await collectEnv(component, host, autoDefaults, resolvedKeys);
  if (!collected) return null;

  return buildComponentAction({ ...base, env: collected, envChanges: collected.changes }, version, host);
}

function generateSecret(length = 40): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

/** Not in getAutoDefaults: that also feeds stack deploys, where per-call secrets would differ per host. */
export function initialSharedSecrets(): Record<string, string> {
  return {
    BETTER_AUTH_SECRET: generateSecret(),
    TETHER_SECRET: generateSecret(),
  };
}

export function coreComponents(opts: { installInfoserver: boolean; installDaemon: boolean }): Component[] {
  return [
    ...(opts.installInfoserver ? ["infoserver" as Component] : []),
    "gateway", "dashboard", "tether",
    ...(opts.installDaemon ? ["daemon" as Component] : []),
  ];
}

/**
 * Collect the full plan. All prompting happens here; nothing on the host
 * changes. Returns null when the user cancels.
 */
export async function planUp(
  components: Component[],
  opts: PlanUpOptions,
  host: Host,
): Promise<UpPlan | null> {
  const shared: Record<string, string> = initialSharedSecrets();
  // Shared values the user already confirmed at an infra step this run;
  // the component wizards skip re-prompting these. Suggested defaults
  // (INFOSERVER_URL, GATEWAY_URL) stay out so their prompts still appear.
  const resolvedKeys = new Set<string>();
  const plan: UpPlan = {
    targetVersion: opts.targetVersion,
    provisionOllama: false,
    components: [],
  };
  let orderedComponents = components;

  if (opts.withInfra) {
    heading("database");
    const dbPlan = await discoverConnectionUrl(host);
    if (!dbPlan) return null;
    plan.provisionPostgres = dbPlan.provision;
    plan.migrations = { connectionUrl: dbPlan.connectionUrl };
    shared.DB_CONNECTION_URL = dbPlan.connectionUrl;
    resolvedKeys.add("DB_CONNECTION_URL");

    heading("redis");
    const redisPlan = await planRedis(host);
    if (redisPlan) {
      shared.REDIS_URL = redisPlan.url;
      resolvedKeys.add("REDIS_URL");
      if (redisPlan.persist || redisPlan.provision) plan.redis = redisPlan;
    } else {
      warn("Redis", "No Redis URL configured");
      const cont = await confirm({ message: "Continue without Redis?", initialValue: true });
      if (isCancel(cont) || !cont) return null;
    }

    log.info(dim(`Model registry guide: ${getProjectUrl()}/tree/main/packages/xinity-infoserver#readme`));
    const installInfoserver = await confirm({
      message: "Install the info server? (optional - most installations use the default at sysinfo.xinity.ai)",
      initialValue: false,
    });
    if (isCancel(installInfoserver)) return null;

    const installDaemon = await confirm({
      message: "Install the daemon? (only needed on inference hardware)",
      initialValue: false,
    });
    if (isCancel(installDaemon)) return null;

    if (installDaemon) {
      const setupOllama = await confirm({
        message: "Set up Ollama on this machine? (one inference driver the daemon can use)",
        initialValue: false,
      });
      if (isCancel(setupOllama)) return null;
      if (setupOllama) {
        plan.provisionOllama = true;
      }
    }

    orderedComponents = coreComponents({ installInfoserver, installDaemon });
  }

  for (const component of orderedComponents) {
    const action = await planComponentAction(component, opts, host, shared, resolvedKeys);
    if (!action) return null;
    plan.components.push(action);

    // An infoserver declared in this run is the one the following
    // components should use, not the hosted default.
    if (component === "infoserver") {
      shared.INFOSERVER_URL = `http://localhost:${action.env.config.PORT ?? INFOSERVER_DEFAULT_PORT}`;
    }

    // Suggested prompt default only: the dashboard's GATEWAY_URL is the
    // public URL, which differs behind a reverse proxy; the user confirms
    // it at the prompt, whose description says so.
    if (component === "gateway") {
      const bind = action.env.config.HOST;
      const gatewayHost = !bind || bind === "0.0.0.0" ? "localhost" : bind;
      shared.GATEWAY_URL = `http://${gatewayHost}:${action.env.config.PORT ?? GATEWAY_DEFAULT_PORT}`;
    }

    if (component === "tether") {
      shared.TETHER_URL = `http://localhost:${action.env.config.PORT ?? TETHER_DEFAULT_PORT}`;

      // Resolved, unlike the URL: a re-prompt could leave daemon and tether with different secrets.
      const secret = action.env.config.TETHER_SECRET;
      if (secret) {
        shared.TETHER_SECRET = secret;
        resolvedKeys.add("TETHER_SECRET");
      }
    }
  }

  return plan;
}

// ─── Review ─────────────────────────────────────────────────────────────────

function envChangeLines(changes: EnvChange[], secretFiles: SecretFilePlan): string[] {
  return changes.map((c) => {
    if (c.kind === "removed") {
      const kept = secretFiles.keptForOtherComponents.includes(c.key)
        ? dim(" (secret file kept, another component still uses it)")
        : "";
      return `- ${c.key}${kept}`;
    }
    const value = c.isSecret ? "••••••" : c.after;
    if (c.kind === "added") return `+ ${c.key} = ${value}`;
    return c.isSecret ? `~ ${c.key} = ••••••` : `~ ${c.key} = ${c.before} → ${c.after}`;
  });
}

function serviceLine(action: ComponentAction): string {
  const unit = unitName(action.component);
  return action.serviceRunning ? `restart ${unit}` : `enable and start ${unit}`;
}

export function describeComponentAction(action: ComponentAction): string[] {
  const { component, envChanges } = action;
  const configLines = envChanges.length > 0
    ? [`config changes:`, ...envChangeLines(envChanges, action.secretFiles).map((l) => `  ${l}`)]
    : ["configuration unchanged"];

  switch (action.kind) {
    case "none": {
      return [`${cyan(component)} ${action.toVersion} is current, configuration unchanged: nothing to do`];
    }
    case "reconfigure": {
      return [
        `Reconfigure ${cyan(component)} (binary ${action.toVersion} stays)`,
        ...configLines.map((l) => `  ${l}`),
        `  update systemd unit, ${serviceLine(action)}`,
      ];
    }
    case "install":
    case "update": {
      const verb = action.kind === "install"
        ? `Install ${cyan(component)} ${action.toVersion}`
        : `Update ${cyan(component)} ${action.installedVersion} → ${action.toVersion}`;
      const source = action.localRepoPath
        ? `build locally from ${action.localRepoPath} and upload`
        : `download ${action.assetName}${action.assetSizeMb ? ` (${action.assetSizeMb} MB)` : ""}`;
      return [
        verb,
        `  ${source}`,
        ...(action.kind === "update" ? ["  back up current binary and configuration"] : []),
        ...(action.hardReset && action.kind === "update" ? ["  hard reset: clean service state"] : []),
        ...configLines.map((l) => `  ${l}`),
        `  update systemd unit, ${serviceLine(action)}`,
      ];
    }
  }
}

export function renderUpPlan(plan: UpPlan): void {
  log.step(bold("Planned actions"));

  let step = 1;
  const item = (lines: string[]) => {
    const [head, ...rest] = lines;
    if (rest.length === 0) {
      log.info(`${step++}. ${head}`);
      return;
    }
    note(rest.map((line) => dim(line.trim())).join("\n"), `${step++}. ${head}`);
  };

  if (plan.provisionPostgres) {
    item([describePostgresProvision(plan.provisionPostgres)]);
  }
  if (plan.migrations) {
    item([describeMigrationStep(plan.targetVersion, plan.migrations.connectionUrl)]);
  }
  if (plan.redis) {
    const lines = describeRedisPlan(plan.redis);
    if (lines.length > 0) item(lines);
  }
  if (plan.provisionOllama) {
    item(["Provision ollama (install when missing, start the service)"]);
  }
  for (const action of plan.components) {
    item(describeComponentAction(action));
  }
}

/** The single go-ahead gate after review. Returns true to apply. */
export async function reviewGate(renderScript?: () => Promise<string>): Promise<boolean> {
  while (true) {
    const options = [
      { value: "apply", label: "Yes, apply these actions" },
      { value: "abort", label: "Abort" },
      ...(renderScript ? [{ value: "script", label: dim("Save the equivalent bash script to a file"), hint: "runs nothing" }] : []),
    ];
    const choice = await select({ message: "Proceed?", options });

    if (isCancel(choice) || choice === "abort") {
      cancel("Aborted, nothing was changed.");
      return false;
    }
    if (choice === "apply") return true;

    const script = await renderScript!();
    const path = join(tmpdir(), `xinity-apply-${Date.now()}.sh`);
    writeFileSync(path, script, { mode: 0o600 });
    log.info(`Script written to ${cyan(path)}`);
    log.info(dim("Contains secrets. Inspect, then run on the target host as root."));
  }
}

// ─── Script dump ────────────────────────────────────────────────────────────

const SCRIPT_HEADER = [
  "#!/usr/bin/env bash",
  "# Equivalent script for the reviewed actions. Run as root on the target host.",
  "# WARNING: contains configuration secrets in plain text.",
  "set -euo pipefail",
  "",
];

function scriptConfigSection(
  component: Component,
  env: EnvBundle,
  serviceRunning: boolean,
  secretFiles: SecretFilePlan,
): string[] {
  const secretsCommand = buildSecretsWriteCommand(env.secrets);
  const removeCommand = buildSecretsRemoveCommand(secretFiles.remove);
  return [
    buildEnvWriteCommand(component, env.config),
    ...(secretsCommand ? [secretsCommand] : []),
    ...(removeCommand ? [removeCommand] : []),
    buildUnitWriteCommand(component, Object.keys(env.secrets)),
    serviceRunning ? `systemctl restart ${unitName(component)}` : `systemctl enable --now ${unitName(component)}`,
  ];
}

export async function scriptComponentSection(action: ComponentAction): Promise<string[]> {
  const { component } = action;
  const header = `# ── ${component}: ${action.kind} ${action.toVersion} ──`;

  if (action.kind === "none") {
    return [`# ── ${component}: ${action.toVersion} already current, nothing to do ──`];
  }
  if (action.kind === "reconfigure") {
    return [header, ...scriptConfigSection(component, action.env, action.serviceRunning, action.secretFiles)];
  }
  if (action.localRepoPath) {
    return [
      header,
      `# local build from ${action.localRepoPath} has no script equivalent (the build runs on the CLI machine)`,
    ];
  }

  const asset = action.release!.assets.find((a) => a.name === action.assetName);
  const url = asset ? await resolveDirectUrl(asset) : "";
  const archivePath = `/tmp/xinity-script-install/${action.assetName}`;
  return [
    header,
    `mkdir -p /tmp/xinity-script-install`,
    `curl -fsSL -o '${archivePath}' '${url}'`,
    buildInstallBinaryCommand(component, archivePath),
    ...scriptConfigSection(component, action.env, action.serviceRunning, action.secretFiles),
  ];
}

/**
 * Bash script reproducing the plan's component actions. Database migrations
 * run through drizzle's programmatic migrator and have no bash equivalent;
 * the script defers them to `xinity up db`.
 */
export async function renderUpPlanScript(plan: UpPlan): Promise<string> {
  const sections: string[] = [...SCRIPT_HEADER];

  if (plan.provisionPostgres) {
    sections.push(
      "# PostgreSQL provisioning (Docker compose stack):",
      ...buildPostgresProvisionCommands(plan.provisionPostgres),
      "",
    );
  }
  if (plan.migrations) {
    sections.push(...migrationScriptComment(`xinity up db --target-version ${plan.targetVersion}`));
  }
  if (plan.redis) {
    sections.push("# Redis (Docker compose stack):");
    if (plan.redis.provision) sections.push(...buildRedisProvisionCommands(plan.redis.provision));
    if (plan.redis.persist) sections.push(buildSecretsWriteCommand({ REDIS_URL: plan.redis.url })!);
    sections.push("");
  }
  if (plan.provisionOllama) {
    sections.push(
      "# Ollama provisioning:",
      "curl -fsSL https://ollama.com/install.sh | sh",
      "systemctl enable --now ollama",
      "",
    );
  }

  for (const action of plan.components) {
    sections.push(...(await scriptComponentSection(action)), "");
  }

  return sections.join("\n");
}

// ─── Apply ──────────────────────────────────────────────────────────────────

export type ApplyResult = {
  success: boolean;
  errors: string[];
}

export async function applyUpPlan(plan: UpPlan, host: Host): Promise<ApplyResult> {
  const errors: string[] = [];

  if (plan.provisionPostgres || plan.migrations) {
    heading("database");
  }
  if (plan.provisionPostgres) {
    if (!(await applyPostgresProvision(plan.provisionPostgres, host))) {
      return { success: false, errors: ["PostgreSQL provisioning failed"] };
    }
  }
  if (plan.migrations) {
    const result = await runMigrations({
      connectionUrl: plan.migrations.connectionUrl,
      targetVersion: plan.targetVersion,
      dryRun: false,
      host,
    });
    if (!result.success) {
      return { success: false, errors: ["Database migrations failed", ...result.errors] };
    }
  }

  if (plan.redis) {
    heading("redis");
    if (!(await applyRedisPlan(plan.redis, host))) {
      warn("Redis", "Redis setup failed; dependent services may not work until it is fixed");
    }
  }

  if (plan.provisionOllama) {
    heading("ollama");
    const { ensureOllama } = await import("./ollama-setup.ts");
    if (!(await ensureOllama(host, false))) {
      warn("Ollama", "Provisioning failed; the daemon may not reach its ollama endpoint");
    }
  }

  for (const action of plan.components) {
    heading(action.component);
    const result = await applyComponentAction(action, host);
    if (!result.success) {
      errors.push(`${action.component}: ${result.errors.join(", ")}`);
    }
  }

  return { success: errors.length === 0, errors };
}

/** Health check + next-steps note shown after a successful `up all` apply. */
export async function printPostInstallSummary(host: Host): Promise<void> {
  heading("health check");
  const { runDoctor } = await import("./doctor.ts");
  const doctorSpinner = spinner();
  doctorSpinner.start("Running diagnostics…");
  const report = await runDoctor({
    interactive: false,
    host,
    spinner: {
      message: (msg: string) => doctorSpinner.message(msg),
      stop: () => doctorSpinner.stop(""),
    },
  });
  doctorSpinner.stop("");

  const { pass: passCount, warn: warnCount, fail: failCount } = report.summary;
  if (failCount > 0) {
    warn("Health", `${failCount} check(s) failed. Run ${cyan("xinity doctor")} for details.`);
  } else if (warnCount > 0) {
    pass("Health", `All checks passed (${warnCount} warning(s))`);
  } else {
    pass("Health", `All ${passCount} checks passed`);
  }

  const summaryLines: string[] = [];

  const dashContent = await host.readFile(`${ENV_DIR}/dashboard.env`);
  const dashboardOrigin = dashContent ? parseEnvString(dashContent).ORIGIN : undefined;
  if (dashboardOrigin) summaryLines.push(`Dashboard:  ${cyan(dashboardOrigin)}`);

  const gwContent = await host.readFile(`${ENV_DIR}/gateway.env`);
  if (gwContent) {
    const parsed = parseEnvString(gwContent);
    const gwHost = parsed.HOST || "localhost";
    const gwPort = parsed.PORT || GATEWAY_DEFAULT_PORT;
    summaryLines.push(`Gateway:    ${cyan(`http://${gwHost}:${gwPort}`)}`);
  }

  if (summaryLines.length > 0) summaryLines.push("");
  summaryLines.push(bold("Next steps:"));
  if (dashboardOrigin) {
    summaryLines.push(`  1. Connect the CLI to your dashboard:`);
    summaryLines.push(`     ${cyan(`xinity configure dashboardUrl ${dashboardOrigin}`)}`);
    summaryLines.push(`  2. Create your admin account from the CLI:`);
    summaryLines.push(`     ${cyan("xinity act onboarding.cli")}`);
    summaryLines.push(`     Or open ${cyan(dashboardOrigin)} in a browser to sign up there.`);
  } else {
    summaryLines.push(`  1. Create your admin account via the dashboard UI`);
    summaryLines.push(`     Or from the CLI: ${cyan("xinity act onboarding.cli")}`);
  }
  summaryLines.push(`  ${dashboardOrigin ? "3" : "2"}. Add inference nodes: ${cyan("xinity up daemon")} on each GPU machine`);
  summaryLines.push(`  ${dashboardOrigin ? "4" : "3"}. Check health anytime: ${cyan("xinity doctor")}`);
  summaryLines.push("");
  summaryLines.push(dim(`Model registry guide: ${getProjectUrl()}/tree/main/packages/xinity-infoserver#readme`));

  note(summaryLines.join("\n"), "Installation complete");
}

// ─── configure <component> ──────────────────────────────────────────────────

/**
 * `xinity configure <component>`: the familiar menu editor, then a review of
 * what actually changed and the same gate as `up`. Writes nothing until
 * confirmed.
 */
export async function configureComponentFlow(component: Component, host: Host): Promise<void> {
  intro(`xinity configure ${cyan(component)}`);

  if (!(await host.prepareElevation())) {
    outro("Aborted");
    return;
  }

  const state = await readExistingEnvState(component, host);
  const existing = { ...getAutoDefaults(component), ...state.existingConfig, ...state.existingSecrets };

  const result = await menuEditEnv(ENV_SCHEMAS[component], existing);
  if (result === null) {
    cancel("Cancelled, no changes saved.");
    return;
  }

  const changes = diffEnv(component, { config: state.existingConfig, secrets: state.existingSecrets }, result);
  if (changes.length === 0) {
    log.info("No changes.");
    outro("Done");
    return;
  }

  const serviceRunning = await isUnitActiveOn(host, unitName(component));
  const secretFiles = await planSecretFileRemoval(component, changes, host);

  note(
    [
      ...envChangeLines(changes, secretFiles),
      dim(serviceRunning
        ? `update systemd unit, restart ${unitName(component)}`
        : `update systemd unit (${unitName(component)} is not running, takes effect on next start)`),
    ].join("\n"),
    bold("Planned changes"),
  );

  const proceed = await reviewGate(async () =>
    [...SCRIPT_HEADER, ...scriptConfigSection(component, result, serviceRunning, secretFiles)].join("\n"),
  );
  if (!proceed) return;

  const progress = createProgress("Applying configuration…");
  const configResult = await writeEnvConfig(component, result.config, result.secrets, host, secretFiles.remove);
  if (configResult.success) {
    progress.update("Environment configured");
    await writeSystemdUnit(component, Object.keys(result.secrets), host);
    const restarted = await runSteps(restartService(component, host), progress);
    progress.done(restarted
      ? `${component} reconfigured, service restarted`
      : `${component} reconfigured (service not running, takes effect on next start)`);
  } else if (configResult.error) {
    progress.fail("Config", configResult.error);
  }
  progress.ensureSettled();
  outro("Done");
}
