/**
 * Stack deployments: collect → review → gate → apply across all hosts.
 *
 * Config is resolved from the stack's layers; whatever a layer is missing is
 * collected ONCE at the right level (stack-wide per component type, per
 * fleet for daemons, per host only as a last resort) through the menu
 * editor, and saved back into the stack so it is never asked again.
 * The plan phase reads and prompts only; hosts change after the gate.
 */
import { cancel, confirm, isCancel, log, note } from "./clack.ts";
import { bold, cyan, dim, yellow } from "picocolors";
import { type Component, ENV_SCHEMAS, INFOSERVER_DEFAULT_PORT } from "./component-meta.ts";
import { type Host, isUnitActiveOn } from "./host.ts";
import { heading, warn, fail, pass } from "./output.ts";
import { unitName } from "./systemd.ts";
import { fetchRelease } from "./github.ts";
import { resolveVersion, applyComponentAction } from "./installer.ts";
import { removeComponent } from "./install-remove.ts";
import { readManifest, saveStackMembership, type StackMembership } from "./manifest.ts";
import { describeMigrationStep, migrationScriptComment, runMigrations } from "./migrator.ts";
import { connectHost } from "./remote-host.ts";
import { type ComponentAction, describeComponentAction, buildComponentAction, reviewGate, scriptComponentSection } from "./up-plan.ts";
import { analyzeEnvSchema, splitValuesByCategory, readExistingEnvState, diffEnv, missingRequiredFields } from "./env-prompt.ts";
import {
  type StackDefinition, type StackHost, type FleetDefinition,
  resolveEnv, saveStack, getFleetForHost, hostLabel,
  componentLayerSeed, fleetLayerSeed,
  STACK_SHARED_SCHEMA,
} from "./stack.ts";
import { editSharedLayer, editComponentLayer, editFleetLayer, editHostLayer } from "./stack-layers.ts";
import { loadStackState, findOrphanHosts, markHostManaged, unmarkHostManaged } from "./stack-state.ts";
import { connectHosts, connectElevated, disposeAll, mapBounded, HOST_CONCURRENCY } from "./multi-host.ts";
import { collectSteps } from "./step-runner.ts";
import { createMultiProgress, createDoneGuard } from "./multi-progress.ts";

export const COMPONENT_ORDER: Component[] = ["infoserver", "gateway", "dashboard", "daemon"];

interface Deployment {
  host: StackHost;
  components: Component[];
}

interface StackHostPlan {
  address: string;
  /** Installed on the host but not tracked by the stack; removed before anything else. */
  removals: { component: Component; version?: string }[];
  actions: ComponentAction[];
  /** Set when the host's manifest doesn't yet record this stack/fleet ownership. */
  membership: StackMembership | null;
  /** Name in the host's manifest when it belongs to a different stack. */
  foreignStack?: string;
  /** Host left the definition; after the removals its membership marker and state entry are cleared. */
  evacuate?: boolean;
  /** Reason the host needs no work and only its state entry is dropped. */
  forget?: string;
}

export interface StackPlan {
  targetVersion: string;
  migration: { url: string; targetTag: string; pending: boolean } | null;
  hostPlans: StackHostPlan[];
}

type StackPlanOutcome =
  | { status: "planned"; plan: StackPlan }
  | { status: "cancelled" }
  | { status: "failed" };

function stackMigrateUrl(stack: StackDefinition): string | undefined {
  return stack.secrets.DB_CONNECTION_URL ?? stack.env.DB_CONNECTION_URL;
}

// ─── Collect ────────────────────────────────────────────────────────────────

function selectDeployments(stack: StackDefinition): Deployment[] {
  const deployments: Deployment[] = [];
  for (const host of stack.hosts) {
    const components = COMPONENT_ORDER.filter((c) => host.components.includes(c));
    if (components.length > 0) {
      deployments.push({ host, components });
    }
  }
  return deployments;
}

/** An in-stack infoserver's URL is derived from its host, not asked for. An explicit stack env value wins. */
function deriveInfoserverUrl(stack: StackDefinition): void {
  if (stack.env.INFOSERVER_URL) {
    return;
  }
  const infoHost = stack.hosts.find((h) => h.components.includes("infoserver"));
  if (!infoHost) {
    return;
  }
  const hostname = infoHost.address === "local"
    ? "localhost"
    : (infoHost.address.split("@").pop() ?? infoHost.address);
  const port = stack.componentEnv.infoserver?.PORT ?? INFOSERVER_DEFAULT_PORT;
  const raw = `http://${hostname}:${port}`;
  try {
    new URL(raw);
  } catch {
    warn("INFOSERVER_URL", `could not derive a valid URL from host address "${infoHost.address}"`);
    return;
  }
  stack.derivedEnv = { ...stack.derivedEnv, INFOSERVER_URL: raw };
  log.info(`INFOSERVER_URL derived from the stack's infoserver host: ${cyan(raw)}`);
}

/**
 * Make sure every involved component type is fully configured at the
 * highest level: the type's stack-wide layer, and per fleet for daemons.
 * Opens the menu editor only on first configuration or when required
 * values are missing; edits are stored as diffs against the layer below.
 */
async function ensureStackLevelConfig(stack: StackDefinition, deployments: Deployment[]): Promise<boolean> {
  if (missingRequiredFields(analyzeEnvSchema(STACK_SHARED_SCHEMA), { ...stack.env, ...stack.secrets }).length > 0) {
    heading("shared settings");
    if (!(await editSharedLayer(stack, "Shared stack settings (new required values)"))) {
      return false;
    }
  }

  const involvedTypes = COMPONENT_ORDER.filter((c) => deployments.some((d) => d.components.includes(c)));
  const daemonAddresses = deployments
    .filter((d) => d.components.includes("daemon"))
    .map((d) => d.host.address);

  const fleetlessDaemons = daemonAddresses.filter((addr) => getFleetForHost(stack, addr) === null);
  if (fleetlessDaemons.length > 0) {
    const hosts = fleetlessDaemons.join(", ");
    warn("Fleet", `${fleetlessDaemons.length === 1 ? "daemon host is" : "daemon hosts are"} not in a fleet: ${hosts}`);
    log.info(dim(`Group daemons into fleets via ${bold(`xinity stack edit ${stack.name}`)} to manage configuration per pool`));
  }

  for (const component of involvedTypes) {
    if (component === "daemon" && daemonAddresses.every((addr) => getFleetForHost(stack, addr) !== null)) {
      continue;
    }
    const missing = missingRequiredFields(analyzeEnvSchema(ENV_SCHEMAS[component]), componentLayerSeed(stack, component));
    if (stack.componentEnv[component] === undefined || missing.length > 0) {
      heading(component);
      if (!(await editComponentLayer(stack, component, `${component} settings (stack-wide, saved to the stack)`))) {
        return false;
      }
    }
  }

  const involvedFleets = [...new Set(daemonAddresses.map((addr) => getFleetForHost(stack, addr)).filter((f): f is FleetDefinition => f !== null))];
  for (const fleet of involvedFleets) {
    const missing = missingRequiredFields(analyzeEnvSchema(ENV_SCHEMAS.daemon), fleetLayerSeed(stack, fleet));
    if (fleet.envOverrides === undefined || missing.length > 0) {
      heading(`daemon · fleet ${fleet.name}`);
      if (!(await editFleetLayer(stack, fleet, `Daemon settings for fleet "${fleet.name}" (saved to the fleet)`))) {
        return false;
      }
    }
  }

  return true;
}

/** Returns null when version resolution fails or the user cancels a per-host prompt. */
async function planHostComponent(
  stack: StackDefinition,
  component: Component,
  address: string,
  host: Host,
  targetVersion: string,
): Promise<ComponentAction | null> {
  const version = await resolveVersion(component, targetVersion, host);
  if (version.status === "failed") {
    return null;
  }

  const fields = analyzeEnvSchema(ENV_SCHEMAS[component]);
  const { existingConfig, existingSecrets } = await readExistingEnvState(component, host);
  const resolved = resolveEnv(stack, component, address);
  // The stack is declarative: its layers win over whatever is on disk, while
  // values the stack does not manage (a hand-set MACHINE_NAME) persist.
  let merged: Record<string, string> = { ...existingConfig, ...existingSecrets, ...resolved };

  const missing = missingRequiredFields(fields, merged);
  if (missing.length > 0) {
    const overrides = await editHostLayer(stack, address, component, merged);
    if (overrides === null) {
      return null;
    }
    merged = { ...merged, ...overrides };
  }

  const env = splitValuesByCategory(fields, merged);
  return buildComponentAction({
    component,
    hardReset: false,
    serviceRunning: await isUnitActiveOn(host, unitName(component)),
    env,
    envChanges: diffEnv({ config: existingConfig, secrets: existingSecrets }, env),
  }, version, host);
}

/**
 * Collect the full plan: evacuations for hosts that left the definition,
 * stack-level config (prompting where required values are missing), then
 * per-host component actions. Nothing on the hosts or in the state file
 * changes here; connections made to orphans are added to orphanHosts so
 * the apply phase reuses them and the caller disposes them.
 */
async function planStack(
  stack: StackDefinition,
  targetVersion: string,
  deployments: Deployment[],
  orphanCandidates: string[],
  hosts: Map<string, Host>,
  orphanHosts: Map<string, Host>,
): Promise<StackPlanOutcome> {
  const migrateUrl = stackMigrateUrl(stack);
  let migration: StackPlan["migration"] = null;
  if (migrateUrl) {
    try {
      const targetTag = (await fetchRelease(targetVersion)).tagName;
      migration = { url: migrateUrl, targetTag, pending: targetTag !== stack.dbMigratedVersion };
    } catch (err) {
      fail("Release", (err as Error).message);
      return { status: "failed" };
    }
  }

  const hostPlans: StackHostPlan[] = [];
  const untracked = (address: string, forget: string): void => {
    hostPlans.push({ address, removals: [], actions: [], membership: null, forget });
  };

  // Hosts the state says we manage but the definition no longer lists get
  // evacuated: everything on them is removed. Unreachable ones are
  // forgotten; a host another stack has since claimed is left to it.
  for (const address of orphanCandidates) {
    const connection = await connectElevated(address);
    if ("failed" in connection) {
      if (connection.failed === "declined") {
        log.error(connection.message);
        return { status: "failed" };
      }
      untracked(address, "no longer in the stack and unreachable");
      continue;
    }
    const host = connection.host;
    orphanHosts.set(address, host);
    const manifest = await readManifest(host);
    if (manifest.stack && manifest.stack.name !== stack.name) {
      untracked(address, `now belongs to stack "${manifest.stack.name}"`);
      continue;
    }
    const removals = COMPONENT_ORDER
      .filter((c) => manifest.components[c])
      .map((c) => ({ component: c, version: manifest.components[c]?.version }));
    if (removals.length === 0 && !manifest.stack) {
      untracked(address, "nothing is installed");
      continue;
    }
    hostPlans.push({ address, removals, actions: [], membership: null, evacuate: true });
  }

  deriveInfoserverUrl(stack);
  if (!(await ensureStackLevelConfig(stack, deployments))) {
    return { status: "cancelled" };
  }

  for (const d of deployments) {
    const host = hosts.get(d.host.address)!;
    const manifest = await readManifest(host);
    const removals = COMPONENT_ORDER
      .filter((c) => manifest.components[c] && !d.host.components.includes(c))
      .map((c) => ({ component: c, version: manifest.components[c]?.version }));

    const fleetName = getFleetForHost(stack, d.host.address)?.name;
    const marked = manifest.stack;
    const membership: StackMembership | null =
      marked?.name === stack.name && marked.fleet === fleetName
        ? null
        : { name: stack.name, ...(fleetName ? { fleet: fleetName } : {}) };
    const foreignStack = marked && marked.name !== stack.name ? marked.name : undefined;

    const actions: ComponentAction[] = [];
    for (const component of d.components) {
      const action = await planHostComponent(stack, component, d.host.address, host, targetVersion);
      if (!action) {
        return { status: "failed" };
      }
      actions.push(action);
    }
    hostPlans.push({ address: d.host.address, removals, actions, membership, foreignStack });
  }

  return { status: "planned", plan: { targetVersion, migration, hostPlans } };
}

// ─── Review ─────────────────────────────────────────────────────────────────

function hostPlanBodyKey(hp: StackHostPlan): string {
  return JSON.stringify({
    f: hp.foreignStack, e: hp.evacuate, g: hp.forget,
    r: hp.removals.map((r) => [r.component, r.version]),
    a: hp.actions.map((a) => describeComponentAction(a)),
    m: hp.membership,
  });
}

function renderStackPlan(plan: StackPlan): void {
  log.step(bold("Planned actions"));
  let step = 1;
  if (plan.migration?.pending) {
    log.info(`${step++}. ${describeMigrationStep(plan.migration.targetTag, plan.migration.url)}`);
  } else if (plan.migration) {
    log.info(dim(`Database migrations already applied for ${plan.migration.targetTag}`));
  }

  const groups = new Map<string, { addresses: string[]; hostPlan: StackHostPlan }>();
  for (const hp of plan.hostPlans) {
    const key = hostPlanBodyKey(hp);
    const g = groups.get(key);
    if (g) {
      g.addresses.push(hp.address);
    } else {
      groups.set(key, { addresses: [hp.address], hostPlan: hp });
    }
  }

  for (const { addresses, hostPlan } of groups.values()) {
    const lines: string[] = [];
    if (hostPlan.foreignStack) {
      lines.push(yellow(`⚠ Marked as belonging to stack "${hostPlan.foreignStack}"; this stack will claim it`));
    }
    if (hostPlan.evacuate) {
      lines.push(yellow("⚠ No longer in the stack definition; everything managed here will be removed"));
    }
    if (hostPlan.forget) {
      lines.push(`${step++}. Stop tracking this host (${hostPlan.forget})`);
    }
    for (const removal of hostPlan.removals) {
      lines.push(`${step++}. Remove ${cyan(removal.component)}${removal.version ? ` ${removal.version}` : ""}`);
      lines.push(dim("   installed on the host but not part of this stack"));
    }
    for (const action of hostPlan.actions) {
      const [head, ...rest] = describeComponentAction(action);
      lines.push(`${step++}. ${head}`);
      for (const line of rest) {
        lines.push(dim(`   ${line}`));
      }
    }
    if (hostPlan.membership) {
      lines.push(`${step++}. Record stack membership: ${cyan(hostPlan.membership.name)}${hostPlan.membership.fleet ? ` · fleet ${cyan(hostPlan.membership.fleet)}` : ""}`);
    }
    if (hostPlan.evacuate) {
      lines.push(`${step++}. Clear stack membership and stop managing this host`);
    }
    const label = addresses.length === 1
      ? addresses[0]!
      : `${addresses.join(", ")} (${addresses.length} hosts)`;
    note(lines.join("\n"), cyan(label));
  }
}

function stackPlanIsEmpty(plan: StackPlan): boolean {
  return !plan.migration?.pending && plan.hostPlans.every(
    (p) => p.removals.length === 0 && p.membership === null && !p.evacuate && !p.forget && p.actions.every((a) => a.kind === "none"),
  );
}

const SCRIPT_HEADER = [
  "#!/usr/bin/env bash",
  "# Equivalent script for the reviewed actions; each section runs as root on the named host.",
  "# WARNING: contains configuration secrets in plain text.",
  "set -euo pipefail",
  "",
];

/**
 * Bash script reproducing the plan's per-host component actions. Steps the
 * CLI performs itself (migrations, membership markers, the state file) have
 * no bash equivalent and appear as comments.
 */
async function renderStackPlanScript(stack: StackDefinition, plan: StackPlan): Promise<string> {
  const sections: string[] = [...SCRIPT_HEADER];
  if (plan.migration?.pending) {
    sections.push(...migrationScriptComment(`xinity stack up ${stack.name}`));
  }
  for (const hostPlan of plan.hostPlans) {
    sections.push(`# ════ ${hostPlan.address} ════`);
    if (hostPlan.forget) {
      sections.push(`# only its state entry is dropped (${hostPlan.forget}); nothing runs here`, "");
      continue;
    }
    for (const removal of hostPlan.removals) {
      sections.push(`# remove ${removal.component}: no bash equivalent; run: xinity rm ${removal.component} --target-host ${hostPlan.address}`);
    }
    for (const action of hostPlan.actions) {
      sections.push(...(await scriptComponentSection(action)));
    }
    if (hostPlan.membership || hostPlan.evacuate) {
      sections.push("# the stack membership marker in the host manifest is maintained by the CLI");
    }
    sections.push("");
  }
  return sections.join("\n");
}

async function confirmForeignClaims(plan: StackPlan): Promise<boolean> {
  const foreignClaims = plan.hostPlans.filter((p) => p.foreignStack);
  if (foreignClaims.length === 0) {
    return true;
  }
  const message = foreignClaims.length === 1
    ? `${foreignClaims[0]!.address} belongs to stack "${foreignClaims[0]!.foreignStack}". Claim it for this stack?`
    : `${foreignClaims.length} hosts belong to other stacks. Claim them for this stack?`;
  const ok = await confirm({ message, initialValue: false });
  if (isCancel(ok) || !ok) {
    cancel("Aborted, nothing was changed.");
    return false;
  }
  return true;
}

// ─── Apply ──────────────────────────────────────────────────────────────────

async function applyStackPlan(
  stack: StackDefinition,
  plan: StackPlan,
  hosts: Map<string, Host>,
  orphanHosts: Map<string, Host>,
): Promise<boolean> {
  if (plan.migration?.pending) {
    heading("database");
    // Migrations run through any stack host's tunnel; without hosts the
    // database must be reachable from this machine directly.
    let migrationHost: Host | undefined = hosts.values().next().value;
    let localFallback: Host | null = null;
    if (!migrationHost) {
      localFallback = await connectHost();
      migrationHost = localFallback;
    }
    try {
      const result = await runMigrations({
        connectionUrl: plan.migration.url,
        targetVersion: plan.targetVersion,
        dryRun: false,
        host: migrationHost,
        persist: false,
      });
      if (!result.success) {
        for (const err of result.errors) {
          fail("Migrations", err);
        }
        return false;
      }
    } finally {
      await localFallback?.dispose();
    }
    stack.dbMigratedVersion = plan.migration.targetTag;
    saveStack(stack);
  }

  for (const hp of plan.hostPlans) {
    if (hp.forget) {
      unmarkHostManaged(stack.name, hp.address);
    } else if (!hp.evacuate) {
      markHostManaged(stack.name, hp.address);
    }
  }

  const active = plan.hostPlans.filter((p) => !p.forget);

  if (active.length > 0) {
    const multi = createMultiProgress({
      message: `Applying to ${active.length} host${active.length === 1 ? "" : "s"}`,
      slots: active.map((p) => p.address),
    });

    const hostResults = await mapBounded(active, HOST_CONCURRENCY, async (hostPlan) => {
      const host = (hosts.get(hostPlan.address) ?? orphanHosts.get(hostPlan.address))!;
      const slot = multi.slot(hostPlan.address);
      const guard = createDoneGuard(slot);
      const errors: { component: string; messages: string[] }[] = [];
      for (const removal of hostPlan.removals) {
        slot.update(`removing ${removal.component}`);
        const { result } = await collectSteps(removeComponent({ component: removal.component, host }));
        if (!result.success) {
          errors.push({ component: removal.component, messages: result.errors });
        }
      }
      for (const action of hostPlan.actions) {
        slot.update(`${action.component}: preparing`);
        const result = await applyComponentAction(action, host, "rollback", guard);
        if (!result.success) {
          errors.push({ component: action.component, messages: result.errors });
        }
      }
      if (hostPlan.membership) {
        await saveStackMembership(hostPlan.membership, host);
      }
      if (errors.length > 0) {
        slot.fail(`${errors.length} component(s) failed`);
      } else {
        slot.done(hostPlan.evacuate ? "evacuated" : "applied");
      }
      return { hostPlan, errors };
    });

    multi.done();

    for (const { hostPlan, errors } of hostResults) {
      if (errors.length > 0) {
        heading(hostPlan.address);
        for (const { component, messages } of errors) {
          for (const msg of messages) {
            fail(component, msg);
          }
        }
      }
    }

    let failures = 0;
    for (const { hostPlan, errors } of hostResults) {
      if (hostPlan.evacuate && errors.length === 0) {
        const host = (hosts.get(hostPlan.address) ?? orphanHosts.get(hostPlan.address))!;
        await saveStackMembership(null, host);
        unmarkHostManaged(stack.name, hostPlan.address);
      }
      failures += errors.length;
    }

    if (failures > 0) {
      warn("Stack", `${failures} component action(s) failed; see above`);
      return false;
    }
    pass("Stack", "All hosts applied successfully");
    log.info(dim(`Run ${bold(`xinity stack doctor ${stack.name}`)} to verify all services are healthy`));
  } else if (plan.migration?.pending) {
    pass("Stack", "Database migrations applied");
  } else {
    pass("Stack", "Stack state updated");
  }
  return true;
}

/**
 * The shared engine behind `stack up`: collect everything, review one plan,
 * gate once (or stop there on a dry run), then apply host by host.
 * Returns false when something failed (as opposed to a clean abort).
 */
export async function runStackFlow(
  stack: StackDefinition,
  opts: { targetVersion: string; dryRun?: boolean },
): Promise<boolean> {
  const deployments = selectDeployments(stack);
  const orphanCandidates = findOrphanHosts(loadStackState(stack.name), stack);

  if (deployments.length === 0 && !stackMigrateUrl(stack) && orphanCandidates.length === 0) {
    warn("Stack", "Nothing to deploy (no matching hosts with components)");
    return true;
  }

  if (deployments.length > 0) {
    log.info(bold("Hosts:"));
    for (const d of deployments) {
      log.info(`  ${hostLabel(d.host)}: ${d.components.map((c) => cyan(c)).join(", ")}`);
    }
  } else if (orphanCandidates.length === 0) {
    log.info(dim(`No hosts defined yet; planning database migrations only. Add hosts with: xinity stack edit ${stack.name}`));
  }

  const hosts = deployments.length > 0
    ? await connectHosts(deployments.map((d) => d.host.address))
    : new Map<string, Host>();
  if (!hosts) {
    return false;
  }

  const orphanHosts = new Map<string, Host>();
  try {
    const outcome = await planStack(stack, opts.targetVersion, deployments, orphanCandidates, hosts, orphanHosts);
    if (outcome.status === "failed") {
      return false;
    }
    if (outcome.status === "cancelled") {
      cancel("Cancelled, nothing was changed on the hosts.");
      return true;
    }

    const plan = outcome.plan;
    renderStackPlan(plan);
    if (stackPlanIsEmpty(plan)) {
      pass("Stack", "Everything is current and configured; nothing to apply");
      return true;
    }
    if (opts.dryRun) {
      log.info(yellow("Dry run, stopping before apply."));
      return true;
    }
    if (!(await confirmForeignClaims(plan))) {
      return true;
    }

    if (!(await reviewGate(() => renderStackPlanScript(stack, plan)))) {
      return true;
    }

    saveStack(stack);
    return await applyStackPlan(stack, plan, hosts, orphanHosts);
  } finally {
    await disposeAll(hosts);
    await disposeAll(orphanHosts);
  }
}
