/**
 * Stack deployments: collect → review → gate → apply across all hosts.
 *
 * Config is resolved from the stack's layers; whatever a layer is missing is
 * collected ONCE at the right level (stack-wide per component type, per
 * fleet for daemons, per host only as a last resort) through the menu
 * editor, and saved back into the stack so it is never asked again.
 * The plan phase reads and prompts only; hosts change after the gate.
 */
import { cancel, log, note } from "./clack.ts";
import { bold, cyan, dim } from "picocolors";
import { type Component, ENV_SCHEMAS } from "./component-meta.ts";
import { type Host, isUnitActiveOn } from "./host.ts";
import { heading, warn, fail, pass } from "./output.ts";
import { unitName } from "./systemd.ts";
import { fetchRelease } from "./github.ts";
import { resolveVersion, applyComponentAction } from "./installer.ts";
import { removeComponentCollapsed } from "./install-remove.ts";
import { readManifest } from "./manifest.ts";
import { dbHint, runMigrations } from "./migrator.ts";
import { connectHost } from "./remote-host.ts";
import { type ComponentAction, describeComponentAction, buildComponentAction, reviewGate } from "./up-plan.ts";
import { analyzeEnvSchema, splitValuesByCategory, menuEditEnv, readExistingEnvState, diffEnv, missingRequiredFields, flattenBundle } from "./env-prompt.ts";
import {
  type StackDefinition, type StackHost, type FleetDefinition,
  resolveEnv, diffFromLayer, saveStack, getHost, hostLabel,
  STACK_SHARED_KEYS, STACK_SHARED_SCHEMA,
} from "./stack.ts";
import { editSharedLayer, editComponentLayer, editFleetLayer, componentLayerSeed, fleetLayerSeed } from "./stack-layers.ts";
import { connectHosts, disposeAll } from "./multi-host.ts";

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
}

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

/** An in-stack infoserver's URL is derived from its host, not asked for. */
function deriveInfoserverUrl(stack: StackDefinition): void {
  if (stack.env.INFOSERVER_URL) return;
  const infoHost = stack.hosts.find((h) => h.components.includes("infoserver"));
  if (!infoHost) return;
  const hostname = infoHost.address === "local"
    ? "localhost"
    : (infoHost.address.split("@").pop() ?? infoHost.address);
  const port = stack.componentEnv.infoserver?.PORT ?? "8090";
  stack.env.INFOSERVER_URL = `http://${hostname}:${port}`;
  log.info(`INFOSERVER_URL derived from the stack's infoserver host: ${cyan(stack.env.INFOSERVER_URL)}`);
}

/**
 * Make sure every involved component type is fully configured at the
 * highest level: the type's stack-wide layer, and per fleet for daemons.
 * Opens the menu editor only on first configuration or when required
 * values are missing; edits are stored as diffs against the layer below.
 */
async function ensureStackLevelConfig(stack: StackDefinition, deployments: Deployment[]): Promise<boolean> {
  // Shared keys added after the stack was created (or by CLI upgrades) get
  // backfilled here, at their owning layer, before any component editor.
  if (missingRequiredFields(analyzeEnvSchema(STACK_SHARED_SCHEMA), { ...stack.env, ...stack.secrets }).length > 0) {
    heading("shared settings");
    if (!(await editSharedLayer(stack, "Shared stack settings (new required values)"))) {
      return false;
    }
    saveStack(stack);
  }

  const involvedTypes = COMPONENT_ORDER.filter((c) => deployments.some((d) => d.components.includes(c)));
  const daemonAddresses = deployments
    .filter((d) => d.components.includes("daemon"))
    .map((d) => d.host.address);
  const fleetOf = new Map<string, FleetDefinition>();
  for (const fleet of stack.fleets) {
    for (const addr of fleet.hosts) {
      fleetOf.set(addr, fleet);
    }
  }

  for (const component of involvedTypes) {
    // Daemon config lives on fleets; the stack-wide layer only matters for
    // daemon hosts that belong to no fleet.
    if (component === "daemon" && daemonAddresses.every((addr) => fleetOf.has(addr))) {
      continue;
    }
    const missing = missingRequiredFields(analyzeEnvSchema(ENV_SCHEMAS[component]), componentLayerSeed(stack, component));
    if (stack.componentEnv[component] === undefined || missing.length > 0) {
      heading(component);
      if (!(await editComponentLayer(stack, component, `${component} settings (stack-wide, saved to the stack)`))) {
        return false;
      }
      saveStack(stack);
    }
  }

  const involvedFleets = [...new Set(daemonAddresses.map((addr) => fleetOf.get(addr)).filter((f): f is FleetDefinition => f !== undefined))];
  for (const fleet of involvedFleets) {
    const missing = missingRequiredFields(analyzeEnvSchema(ENV_SCHEMAS.daemon), fleetLayerSeed(stack, fleet));
    if (fleet.envOverrides === undefined || missing.length > 0) {
      heading(`daemon · fleet ${fleet.name}`);
      if (!(await editFleetLayer(stack, fleet, `Daemon settings for fleet "${fleet.name}" (saved to the fleet)`))) {
        return false;
      }
      saveStack(stack);
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
  if (version.status === "failed") return null;

  const fields = analyzeEnvSchema(ENV_SCHEMAS[component]);
  const { existingConfig, existingSecrets } = await readExistingEnvState(component, host);
  const resolved = resolveEnv(stack, component, address);
  // The stack is declarative: its layers win over whatever is on disk, while
  // values the stack does not manage (a hand-set MACHINE_NAME) persist.
  let merged: Record<string, string> = { ...existingConfig, ...existingSecrets, ...resolved };

  const missing = missingRequiredFields(fields, merged);
  if (missing.length > 0) {
    const result = await menuEditEnv(ENV_SCHEMAS[component], merged, {
      hiddenKeys: STACK_SHARED_KEYS,
      message: `${component} settings for ${address} (saved as host overrides)`,
    });
    if (result === null) return null;
    const overrides = diffFromLayer(flattenBundle(result), merged);
    const stackHost = getHost(stack, address);
    if (stackHost && Object.keys(overrides).length > 0) {
      stackHost.envOverrides = { ...stackHost.envOverrides, ...overrides };
      saveStack(stack);
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

function renderStackPlan(plans: StackHostPlan[], firstStep: number): void {
  let step = firstStep;
  for (const plan of plans) {
    const lines: string[] = [];
    for (const removal of plan.removals) {
      lines.push(`${step++}. Remove ${cyan(removal.component)}${removal.version ? ` ${removal.version}` : ""}`);
      lines.push(dim("   installed on the host but not part of this stack"));
    }
    for (const action of plan.actions) {
      const [head, ...rest] = describeComponentAction(action);
      lines.push(`${step++}. ${head}`);
      for (const line of rest) {
        lines.push(dim(`   ${line}`));
      }
    }
    note(lines.join("\n"), cyan(plan.address));
  }
}

/**
 * The shared engine behind `stack up` and `fleet up`: collect everything,
 * review one plan, gate once, then apply host by host.
 * Returns false when something failed (as opposed to a clean abort).
 */
export async function runStackFlow(
  stack: StackDefinition,
  opts: { targetVersion: string },
): Promise<boolean> {
  const deployments = selectDeployments(stack);
  const migrateUrl = stack.secrets.DB_CONNECTION_URL ?? stack.env.DB_CONNECTION_URL;

  if (deployments.length === 0 && !migrateUrl) {
    warn("Stack", "Nothing to deploy (no matching hosts with components)");
    return true;
  }

  if (deployments.length > 0) {
    log.info(bold("Hosts:"));
    for (const d of deployments) {
      log.info(`  ${hostLabel(d.host)}: ${d.components.map((c) => cyan(c)).join(", ")}`);
    }
  } else {
    log.info(dim(`No hosts defined yet; planning database migrations only. Add hosts with: xinity stack edit ${stack.name}`));
  }

  let targetTag: string | null = null;
  if (migrateUrl) {
    try {
      targetTag = (await fetchRelease(opts.targetVersion)).tagName;
    } catch (err) {
      fail("Release", (err as Error).message);
      return false;
    }
  }
  const migrationsPending = migrateUrl !== undefined && targetTag !== stack.dbMigratedVersion;

  const hosts = deployments.length > 0
    ? await connectHosts(deployments.map((d) => d.host.address))
    : new Map<string, Host>();
  if (!hosts) return false;

  let localFallback: Host | null = null;
  try {
    deriveInfoserverUrl(stack);
    if (!(await ensureStackLevelConfig(stack, deployments))) {
      cancel("Cancelled, nothing was changed on the hosts.");
      return true;
    }

    const plans: StackHostPlan[] = [];
    for (const d of deployments) {
      const host = hosts.get(d.host.address)!;

      const manifest = await readManifest(host);
      const removals = COMPONENT_ORDER
        .filter((c) => manifest.components[c] && !d.host.components.includes(c))
        .map((c) => ({ component: c, version: manifest.components[c]?.version }));

      const actions: ComponentAction[] = [];
      for (const component of d.components) {
        const action = await planHostComponent(stack, component, d.host.address, host, opts.targetVersion);
        if (!action) return false;
        actions.push(action);
      }
      plans.push({ address: d.host.address, removals, actions });
    }

    log.step(bold("Planned actions"));
    let firstStep = 1;
    if (migrationsPending) {
      log.info(`${firstStep++}. Apply database migrations from release ${targetTag} to ${dbHint(migrateUrl!)}`);
    } else if (migrateUrl) {
      log.info(dim(`Database migrations already applied for ${targetTag}`));
    }
    renderStackPlan(plans, firstStep);

    const nothingToDo = plans.every(
      (plan) => plan.removals.length === 0 && plan.actions.every((a) => a.kind === "none"),
    );
    if (!migrationsPending && nothingToDo) {
      pass("Stack", "Everything is current and configured; nothing to apply");
      return true;
    }

    if (!(await reviewGate())) return true;

    if (migrationsPending) {
      heading("database");
      // Migrations run through any stack host's tunnel; without hosts the
      // database must be reachable from this machine directly.
      let migrationHost: Host | undefined = hosts.values().next().value;
      if (!migrationHost) {
        localFallback = await connectHost();
        migrationHost = localFallback;
      }
      const result = await runMigrations({
        connectionUrl: migrateUrl!,
        targetVersion: opts.targetVersion,
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
      stack.dbMigratedVersion = targetTag!;
      saveStack(stack);
    }

    let failures = 0;
    for (const plan of plans) {
      heading(plan.address);
      const host = hosts.get(plan.address)!;
      // Strays go first: a component moving between roles could otherwise
      // collide with its replacement over ports or paths.
      for (const removal of plan.removals) {
        const result = await removeComponentCollapsed({ component: removal.component, host });
        if (!result.success) {
          failures++;
          for (const err of result.errors) {
            fail(removal.component, err);
          }
        }
      }
      for (const action of plan.actions) {
        const result = await applyComponentAction(action, host);
        if (!result.success) {
          failures++;
          for (const err of result.errors) {
            fail(action.component, err);
          }
        }
      }
    }

    if (failures > 0) {
      warn("Stack", `${failures} component action(s) failed; see above`);
      return false;
    }
    pass("Stack", deployments.length > 0 ? "All hosts applied successfully" : "Database migrations applied");
    return true;
  } finally {
    await disposeAll(hosts);
    await localFallback?.dispose();
  }
}
