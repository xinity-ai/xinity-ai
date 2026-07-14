import type { CommandModule } from "yargs";
import { intro, outro, cancel, note, log, select, confirm, text, multiselect } from "../lib/clack.ts";
import { bold, cyan, dim, green, red, yellow } from "picocolors";
import { promptOrExit, promptOrUndefined, fail, warn, heading } from "../lib/output.ts";
import { type Component } from "../lib/component-meta.ts";
import {
  type StackDefinition,
  type StackHost,
  type FleetDefinition,
  createStack,
  loadStack,
  saveStack,
  deleteStack,
  listStacks,
  validateStack,
  getFleet,
  getHost,
  hostLabel,
} from "../lib/stack.ts";
import { editSharedLayer, editComponentLayer, editFleetLayer } from "../lib/stack-layers.ts";
import { searchSelect, searchMultiselect } from "../lib/search-list.ts";
import { runStackFlow } from "../lib/stack-plan.ts";
import { runDoctor, buildSummaryLine } from "../lib/doctor.ts";
import { fetchRelease } from "../lib/github.ts";
import { removeComponentCollapsed } from "../lib/install-remove.ts";
import { connectHosts, forEachHost, disposeAll } from "../lib/multi-host.ts";

const AVAILABLE_COMPONENTS: Component[] = ["gateway", "dashboard", "daemon", "infoserver"];

// ── Helpers ──────────────────────────────────────────────────────────────

function requireStack(name: string): StackDefinition {
  const stack = loadStack(name);
  if (!stack) {
    log.error(`Stack "${name}" not found`);
    process.exit(1);
  }
  return stack;
}

function requireFleet(stack: StackDefinition, fleetName: string): FleetDefinition {
  const fleet = getFleet(stack, fleetName);
  if (!fleet) {
    log.error(`Fleet "${fleetName}" not found in stack "${stack.name}"`);
    process.exit(1);
  }
  return fleet;
}

async function resolveLatestTag(): Promise<string | null> {
  try {
    return (await fetchRelease("latest")).tagName;
  } catch {
    log.warn("Could not reach the release registry to check for updates");
    return null;
  }
}

/** Sets stack.pinnedVersion interactively. Returns false when no version could be determined. */
async function promptPinnedVersion(stack: StackDefinition): Promise<boolean> {
  const latest = await resolveLatestTag();
  const version = await promptOrExit(text({
    message: "Stack release version (every component is held at this version)",
    defaultValue: latest ?? undefined,
    placeholder: latest ?? "vX.Y.Z",
    validate: (v) => (!v && !latest ? "A version is required" : undefined),
  }));
  const chosen = version || latest;
  if (!chosen) {
    return false;
  }
  stack.pinnedVersion = chosen;
  return true;
}

function printStackSummary(stack: StackDefinition): void {
  log.step(bold(`Stack: ${stack.name}`));

  const envKeys = Object.keys(stack.env);
  const secretKeys = Object.keys(stack.secrets);
  if (envKeys.length > 0 || secretKeys.length > 0) {
    log.info(bold("Shared"));
    for (const key of envKeys) {
      log.info(`  ${key} = ${cyan(stack.env[key])}`);
    }
    for (const key of secretKeys) {
      log.info(`  ${key} = ${dim("••••••")}`);
    }
  }

  for (const [component, values] of Object.entries(stack.componentEnv)) {
    if (!values || Object.keys(values).length === 0) continue;
    log.info(bold(component));
    for (const [k, v] of Object.entries(values)) {
      log.info(`  ${k} = ${cyan(v)}`);
    }
  }

  const printOverrides = (overrides?: Record<string, string>) => {
    for (const [k, v] of Object.entries(overrides ?? {})) {
      log.info(`    ${dim(`${k} = ${v}`)}`);
    }
  };

  if (stack.hosts.length > 0) {
    log.info(bold("Hosts"));
    for (const host of stack.hosts) {
      log.info(`  ${hostLabel(host)}: ${host.components.map((c) => cyan(c)).join(", ")}`);
      printOverrides(host.envOverrides);
    }
  }

  if (stack.fleets.length > 0) {
    log.info(bold("Fleets"));
    for (const fleet of stack.fleets) {
      log.info(`  ${fleet.name}: ${fleet.hosts.join(", ")}`);
      printOverrides(fleet.envOverrides);
    }
  }
}

// ── Init ─────────────────────────────────────────────────────────────────

async function handleInit(name: string): Promise<void> {
  if (loadStack(name)) {
    log.error(`Stack "${name}" already exists`);
    process.exit(1);
  }

  const stack = createStack(name);
  const nameError = validateStack(stack).find((e) => e.field === "name");
  if (nameError) {
    log.error(`Invalid stack name: ${nameError.message}`);
    process.exit(1);
  }

  intro(`xinity stack init ${cyan(name)}`);

  if (!(await promptPinnedVersion(stack))) {
    cancel("Cancelled, stack not created.");
    return;
  }

  const hostsOwnInfoserver = await promptOrExit(confirm({
    message: "Will this stack host its own infoserver? (rarely needed; its URL is derived at deploy time)",
    initialValue: false,
  }));

  // Daemon settings are deliberately absent here: they describe hardware
  // pools and live on fleets (with an optional stack-wide baseline under
  // `stack edit` → Component settings).
  const components: Component[] = hostsOwnInfoserver
    ? ["infoserver", "gateway", "dashboard"]
    : ["gateway", "dashboard"];
  if (hostsOwnInfoserver) {
    // Marks the infoserver as stack-hosted, which hides INFOSERVER_URL from
    // the shared editor; the URL is derived from its host at deploy time.
    stack.componentEnv.infoserver = {};
  } else {
    stack.env.INFOSERVER_URL = "https://sysinfo.xinity.ai";
  }

  if (!(await editSharedLayer(stack))) {
    cancel("Cancelled, stack not created.");
    return;
  }

  for (const component of components) {
    heading(component);
    if (!(await editComponentLayer(stack, component))) {
      cancel("Cancelled, stack not created.");
      return;
    }
  }

  saveStack(stack);
  log.success("Stack saved and fully configured");
  note(
    [
      `1. Add hosts and fleets:   ${cyan(`xinity stack edit ${name}`)}`,
      `2. Deploy the stack:       ${cyan(`xinity stack up ${name}`)}`,
      `3. Check health any time:  ${cyan(`xinity stack doctor ${name}`)}`,
    ].join("\n"),
    "Next steps",
  );
  outro("Done");
}

// ── Edit ─────────────────────────────────────────────────────────────────

async function handleEdit(name: string, fleetName?: string): Promise<void> {
  const stack = requireStack(name);
  intro(`xinity stack edit ${cyan(name)}${fleetName ? ` · fleet ${cyan(fleetName)}` : ""}`);

  if (fleetName) {
    await editFleetLayer(stack, requireFleet(stack, fleetName));
  } else {
    // Escape at the top level behaves like Save & exit: submenu edits are
    // already applied in memory and must not be discarded silently.
    while (true) {
      const choice = await promptOrUndefined(select({
        message: "What would you like to edit?",
        options: [
          { value: "shared", label: `Shared settings (${Object.keys(stack.env).length + Object.keys(stack.secrets).length} set)` },
          { value: "component", label: "Component settings (stack-wide per type)" },
          { value: "version", label: `Release version (${stack.pinnedVersion ?? yellow("not set")})` },
          { value: "hosts", label: `Hosts (${stack.hosts.length})` },
          { value: "fleets", label: `Fleets (${stack.fleets.length})` },
          { value: "save", label: green("Save & exit") },
        ],
      })) as string | undefined;

      if (choice === undefined || choice === "save") {
        break;
      }
      if (choice === "shared") {
        await editSharedLayer(stack);
      } else if (choice === "component") {
        await editComponentSettings(stack);
      } else if (choice === "version") {
        await editPinnedVersion(stack);
      } else if (choice === "hosts") {
        await hostsMenu(stack);
      } else if (choice === "fleets") {
        await fleetsMenu(stack);
      }
    }
  }

  saveStack(stack);
  log.success("Stack saved");
  log.info(dim(`Apply changes to the hosts with: xinity stack up ${name}`));
  outro("Done");
}

async function editPinnedVersion(stack: StackDefinition): Promise<void> {
  const latest = await resolveLatestTag();
  if (latest && stack.pinnedVersion && latest !== stack.pinnedVersion) {
    log.info(`Latest available: ${cyan(latest)} (currently pinned to ${stack.pinnedVersion})`);
  }
  const version = await promptOrUndefined(text({
    message: "Stack release version",
    defaultValue: stack.pinnedVersion ?? latest ?? undefined,
    placeholder: latest ?? "vX.Y.Z",
  }));
  if (version) {
    stack.pinnedVersion = version;
  }
}

async function editComponentSettings(stack: StackDefinition): Promise<void> {
  const component = await promptOrUndefined(select({
    message: "Which component type?",
    options: AVAILABLE_COMPONENTS.map((c) => {
      const count = Object.keys(stack.componentEnv[c] ?? {}).length;
      return { value: c, label: `${c}${count > 0 ? dim(` (${count} set)`) : ""}` };
    }),
  })) as Component | undefined;
  if (component) {
    await editComponentLayer(stack, component);
  }
}

/**
 * Fleet membership is exclusive: hosts already in another fleet sort to the
 * bottom, dimmed and marked; selecting one moves it into this fleet.
 */
function fleetHostOptions(stack: StackDefinition, fleet: FleetDefinition | null) {
  const ownerOf = new Map<string, FleetDefinition>();
  for (const other of stack.fleets) {
    if (other === fleet) continue;
    for (const addr of other.hosts) {
      ownerOf.set(addr, other);
    }
  }

  const free: { value: string; label: string; hint?: string }[] = [];
  const taken: { value: string; label: string; hint?: string }[] = [];
  for (const host of stack.hosts) {
    if (!host.components.includes("daemon")) continue;
    const owner = ownerOf.get(host.address);
    if (owner) {
      taken.push({
        value: host.address,
        label: dim(hostLabel(host)),
        hint: `in fleet "${owner.name}"; selecting moves it here`,
      });
    } else {
      free.push({ value: host.address, label: hostLabel(host) });
    }
  }

  return [...free, ...taken];
}

/** Assign members to a fleet, pulling any that belonged to other fleets. */
function claimFleetHosts(stack: StackDefinition, fleet: FleetDefinition, members: string[]): void {
  const claimed = new Set(members);
  fleet.hosts = members;
  for (const other of stack.fleets) {
    if (other === fleet) continue;
    const remaining = other.hosts.filter((a) => !claimed.has(a));
    if (remaining.length === 0 && other.hosts.length > 0) {
      log.warn(`Fleet "${other.name}" lost its last host and was removed`);
    }
    other.hosts = remaining;
  }
  stack.fleets = stack.fleets.filter((f) => f.hosts.length > 0);
}

/** Hosts no longer running a daemon can't stay fleet members. */
function pruneFleetMembership(stack: StackDefinition, address: string): void {
  for (const fleet of stack.fleets) {
    fleet.hosts = fleet.hosts.filter((a) => a !== address);
  }
  stack.fleets = stack.fleets.filter((f) => f.hosts.length > 0);
}

async function hostsMenu(stack: StackDefinition): Promise<void> {
  while (true) {
    const choice = await promptOrUndefined(searchSelect({
      message: "Hosts",
      options: [
        ...stack.hosts.map((h) => ({
          value: h.address,
          label: hostLabel(h),
          hint: h.components.join(", "),
        })),
        { value: "__add__", label: cyan("+ Add a host") },
        { value: "__back__", label: dim("Back") },
      ],
    }));

    if (choice === undefined || choice === "__back__") {
      return;
    }
    if (choice === "__add__") {
      await addHostInteractive(stack);
      continue;
    }
    const host = getHost(stack, choice);
    if (host) {
      await hostMenu(stack, host);
    }
  }
}

async function hostMenu(stack: StackDefinition, host: StackHost): Promise<void> {
  while (true) {
    const choice = await promptOrUndefined(select({
      message: hostLabel(host),
      options: [
        { value: "components", label: `Components (${host.components.join(", ") || yellow("none")})` },
        { value: "alias", label: `Alias (${host.alias ?? "not set"})` },
        { value: "remove", label: red("Remove this host from the stack") },
        { value: "back", label: dim("Back") },
      ],
    })) as string | undefined;

    if (choice === undefined || choice === "back") {
      return;
    }

    if (choice === "components") {
      const components = await promptOrUndefined(multiselect({
        message: `Components for ${host.address}`,
        options: AVAILABLE_COMPONENTS.map((c) => ({ value: c, label: c })),
        initialValues: host.components,
        required: true,
      })) as Component[] | undefined;
      if (!components) {
        continue;
      }
      host.components = components;
      if (!components.includes("daemon")) {
        pruneFleetMembership(stack, host.address);
      }
      continue;
    }

    if (choice === "alias") {
      const alias = await promptOrUndefined(text({
        message: "Alias (leave empty to remove)",
        placeholder: host.alias ?? "friendly-name",
      }));
      if (alias === undefined) {
        continue;
      }
      if (alias) {
        host.alias = alias;
      } else {
        delete host.alias;
      }
      continue;
    }

    if (choice === "remove") {
      const confirmed = await promptOrUndefined(confirm({
        message: `Remove ${hostLabel(host)} from the stack? (nothing is uninstalled)`,
        initialValue: false,
      }));
      if (confirmed) {
        stack.hosts = stack.hosts.filter((h) => h.address !== host.address);
        pruneFleetMembership(stack, host.address);
        log.success(`Removed ${host.address}`);
        return;
      }
    }
  }
}

async function addHostInteractive(stack: StackDefinition): Promise<void> {
  const address = await promptOrUndefined(text({
    message: "SSH address (or 'local')",
    placeholder: "user@hostname",
  }));
  if (!address) {
    return;
  }
  if (stack.hosts.some((h) => h.address === address)) {
    log.warn(`Host ${address} already exists in this stack`);
    return;
  }

  const components = await promptOrUndefined(multiselect({
    message: `Components for ${address}`,
    options: AVAILABLE_COMPONENTS.map((c) => ({ value: c, label: c })),
    required: true,
  })) as Component[] | undefined;
  if (!components) {
    return;
  }

  const host: StackHost = { address, components };

  const setAlias = await promptOrUndefined(confirm({ message: "Set an alias?", initialValue: false }));
  if (setAlias) {
    const alias = await promptOrUndefined(text({ message: "Alias" }));
    if (alias) {
      host.alias = alias;
    }
  }

  stack.hosts.push(host);
  log.success(`Added ${address}`);
}

async function fleetsMenu(stack: StackDefinition): Promise<void> {
  while (true) {
    const choice = await promptOrUndefined(select({
      message: "Fleets",
      options: [
        ...stack.fleets.map((f) => ({
          value: f.name,
          label: f.name,
          hint: f.hosts.join(", "),
        })),
        { value: "__add__", label: cyan("+ Add a fleet") },
        { value: "__back__", label: dim("Back") },
      ],
    })) as string | undefined;

    if (choice === undefined || choice === "__back__") {
      return;
    }
    if (choice === "__add__") {
      const fleet = await addFleetInteractive(stack);
      if (fleet) {
        // A fleet's daemon settings belong to the moment it is created;
        // saving the editor untouched keeps the stack-wide baseline.
        await editFleetLayer(stack, fleet);
      }
      continue;
    }
    const fleet = getFleet(stack, choice);
    if (fleet) {
      await fleetMenu(stack, fleet);
    }
  }
}

async function fleetMenu(stack: StackDefinition, fleet: FleetDefinition): Promise<void> {
  while (true) {
    const choice = await promptOrUndefined(select({
      message: `Fleet "${fleet.name}"`,
      options: [
        { value: "settings", label: `Daemon settings (${Object.keys(fleet.envOverrides ?? {}).length} override(s))` },
        { value: "hosts", label: `Hosts (${fleet.hosts.join(", ") || yellow("none")})` },
        { value: "remove", label: red("Remove this fleet") },
        { value: "back", label: dim("Back") },
      ],
    })) as string | undefined;

    if (choice === undefined || choice === "back") {
      return;
    }

    if (choice === "settings") {
      await editFleetLayer(stack, fleet);
      continue;
    }

    if (choice === "hosts") {
      if (!stack.hosts.some((h) => h.components.includes("daemon"))) {
        log.warn("No hosts with the daemon component in this stack");
        continue;
      }
      const members = await promptOrUndefined(searchMultiselect({
        message: `Daemon hosts in "${fleet.name}"`,
        options: fleetHostOptions(stack, fleet),
        initialValues: fleet.hosts,
        required: true,
      }));
      if (members) {
        claimFleetHosts(stack, fleet, members);
      }
      continue;
    }

    if (choice === "remove") {
      const confirmed = await promptOrUndefined(confirm({
        message: `Remove fleet "${fleet.name}"? (hosts and their daemons stay)`,
        initialValue: false,
      }));
      if (confirmed) {
        stack.fleets = stack.fleets.filter((f) => f.name !== fleet.name);
        log.success(`Fleet "${fleet.name}" removed`);
        return;
      }
    }
  }
}

async function addFleetInteractive(stack: StackDefinition): Promise<FleetDefinition | null> {
  const daemonHosts = stack.hosts.filter((h) => h.components.includes("daemon"));
  if (daemonHosts.length === 0) {
    log.warn("No hosts with the daemon component to form a fleet");
    return null;
  }

  const fleetName = await promptOrUndefined(text({ message: "Fleet name", placeholder: "e.g. gpu-pool" }));
  if (!fleetName) {
    return null;
  }
  if (stack.fleets.some((f) => f.name === fleetName)) {
    log.warn(`Fleet "${fleetName}" already exists`);
    return null;
  }

  const members = await promptOrUndefined(searchMultiselect({
    message: "Select daemon hosts",
    options: fleetHostOptions(stack, null),
    required: true,
  }));
  if (!members) {
    return null;
  }

  const fleet: FleetDefinition = { name: fleetName, hosts: [] };
  stack.fleets.push(fleet);
  claimFleetHosts(stack, fleet, members);
  log.success(`Fleet "${fleetName}" created with ${members.length} host(s)`);
  return fleet;
}

// ── Up ───────────────────────────────────────────────────────────────────

async function handleUp(name: string, versionFlag?: string): Promise<void> {
  const stack = requireStack(name);
  intro(`xinity stack up ${cyan(name)}`);

  // The stack is held at its pinned version; updates only on express intent
  // (the --target-version flag, or saying yes to the update offer).
  if (versionFlag) {
    try {
      stack.pinnedVersion = (await fetchRelease(versionFlag)).tagName;
    } catch (err) {
      log.error(`Could not resolve version ${versionFlag}: ${(err as Error).message}`);
      outro("Failed");
      process.exit(1);
    }
    saveStack(stack);
  } else if (!stack.pinnedVersion) {
    if (!(await promptPinnedVersion(stack))) {
      outro("Aborted");
      return;
    }
    saveStack(stack);
  } else {
    const latest = await resolveLatestTag();
    if (latest && latest !== stack.pinnedVersion) {
      const update = await promptOrExit(confirm({
        message: `A newer release is available. Update the stack from ${stack.pinnedVersion} to ${latest}?`,
        initialValue: false,
      }));
      if (update) {
        stack.pinnedVersion = latest;
        saveStack(stack);
      }
    }
  }
  log.info(`Stack version: ${cyan(stack.pinnedVersion!)}`);

  const ok = await runStackFlow(stack, { targetVersion: stack.pinnedVersion! });
  outro(ok ? "Done" : "Failed");
  if (!ok) {
    process.exit(1);
  }
}

// ── Doctor ────────────────────────────────────────────────────────────────

async function handleDoctor(name: string, fleetName?: string): Promise<void> {
  const stack = requireStack(name);
  const addresses = fleetName
    ? requireFleet(stack, fleetName).hosts
    : stack.hosts.map((h) => h.address);
  intro(`xinity stack doctor ${cyan(name)}${fleetName ? ` · fleet ${cyan(fleetName)}` : ""}`);

  if (addresses.length === 0) {
    log.warn("No hosts to check");
    outro("Nothing to do");
    return;
  }

  const hosts = await connectHosts(addresses);
  if (!hosts) {
    outro("Failed");
    process.exit(1);
  }

  let totalFailed = 0;
  try {
    await forEachHost(hosts, async (host) => {
      const report = await runDoctor({ host, interactive: false });
      totalFailed += report.summary.fail;

      for (const component of report.components) {
        for (const check of component.checks) {
          if (check.status === "fail") {
            fail(`${component.component} · ${check.label}`, check.message);
          } else if (check.status === "warn") {
            warn(`${component.component} · ${check.label}`, check.message);
          }
        }
      }

      log.info(buildSummaryLine(report.summary));
    });
  } finally {
    await disposeAll(hosts);
  }

  outro(totalFailed > 0 ? red("Some checks failed") : green("All checks passed"));
  if (totalFailed > 0) {
    process.exit(1);
  }
}

async function handleRm(name: string): Promise<void> {
  const stack = requireStack(name);
  intro(`xinity stack rm ${cyan(name)}`);

  if (stack.hosts.length === 0) {
    const confirmed = await promptOrExit(confirm({
      message: `Delete stack "${name}"?`,
      initialValue: false,
    }));
    if (!confirmed) {
      outro("Aborted");
      return;
    }
    deleteStack(name);
    log.success(`Stack "${name}" deleted`);
    outro("Done");
    return;
  }

  log.info(bold("Tracked hosts:"));
  for (const host of stack.hosts) {
    log.info(`  ${host.address}: ${host.components.join(", ")}`);
  }

  const choice = await promptOrExit(select({
    message: `How should "${name}" be removed?`,
    options: [
      { value: "local", label: "Remove the local stack definition only", hint: "hosts stay untouched" },
      { value: "teardown", label: `Uninstall all tracked components from ${stack.hosts.length} host(s), then remove the definition`, hint: "best effort" },
      { value: "abort", label: "Abort" },
    ],
  })) as string;

  if (choice === "abort") {
    outro("Aborted");
    return;
  }

  if (choice === "teardown") {
    const done = await teardownHosts(
      stack.hosts.map((h) => h.address),
      (address) => getHost(stack, address)?.components ?? [],
    );
    if (!done) {
      log.error("Could not reach all hosts; nothing was removed and the stack definition was kept.");
      outro("Failed");
      process.exit(1);
    }
  }

  deleteStack(name);
  log.success(`Stack "${name}" deleted`);
  outro("Done");
}

/** Best-effort removal across hosts; failures are reported and treated as removed. */
async function teardownHosts(
  addresses: string[],
  componentsFor: (address: string) => Component[],
): Promise<boolean> {
  const hosts = await connectHosts(addresses);
  if (!hosts) {
    return false;
  }
  try {
    await forEachHost(hosts, async (host, address) => {
      for (const component of componentsFor(address)) {
        const result = await removeComponentCollapsed({ component, host });
        if (!result.success) {
          warn(component, `Not fully removed (${result.errors.join(", ")}); treating it as deleted`);
        }
      }
    });
    return true;
  } finally {
    await disposeAll(hosts);
  }
}

/** `stack rm <name> --fleet <fleet>`: remove the fleet concept, or tear its daemons down too. */
async function handleRmFleet(name: string, fleetName: string): Promise<void> {
  const stack = requireStack(name);
  const fleet = requireFleet(stack, fleetName);
  intro(`xinity stack rm ${cyan(name)} · fleet ${cyan(fleetName)}`);

  let choice = "concept";
  if (fleet.hosts.length > 0) {
    log.info(bold("Fleet hosts:"));
    for (const addr of fleet.hosts) {
      log.info(`  ${addr}`);
    }

    choice = await promptOrExit(select({
      message: `How should fleet "${fleetName}" be removed?`,
      options: [
        { value: "concept", label: "Remove the fleet definition only", hint: "hosts and their daemons stay untouched" },
        { value: "teardown", label: `Uninstall the daemon from ${fleet.hosts.length} host(s), then remove the fleet`, hint: "best effort" },
        { value: "abort", label: "Abort" },
      ],
    })) as string;
  } else {
    const confirmed = await promptOrExit(confirm({
      message: `Remove fleet "${fleetName}"?`,
      initialValue: false,
    }));
    if (!confirmed) {
      choice = "abort";
    }
  }

  if (choice === "abort") {
    outro("Aborted");
    return;
  }

  if (choice === "teardown") {
    if (!(await teardownHosts(fleet.hosts, () => ["daemon"]))) {
      log.error("Could not reach all hosts; nothing was removed and the fleet was kept.");
      outro("Failed");
      process.exit(1);
    }

    // The stack must stop expecting daemons here, or the next `stack up`
    // would simply reinstall what was just torn down.
    for (const addr of fleet.hosts) {
      const stackHost = getHost(stack, addr);
      if (stackHost) {
        stackHost.components = stackHost.components.filter((c) => c !== "daemon");
      }
    }
    stack.hosts = stack.hosts.filter((h) => h.components.length > 0);
  }

  stack.fleets = stack.fleets.filter((f) => f.name !== fleetName);
  saveStack(stack);
  log.success(`Fleet "${fleetName}" removed`);
  outro("Done");
}

// ── Command module ───────────────────────────────────────────────────────

export const stackCommand: CommandModule = {
  command: "stack <action>",
  describe: "Manage deployment stacks",
  builder: (yargs) =>
    yargs
      .command("init <name>", "Create a new stack (shared settings only)", (y) =>
        y.positional("name", { type: "string", demandOption: true, describe: "Stack name" }),
      (argv) => handleInit(argv.name as string))
      .command("ls", "List all stacks", {}, () => {
        const names = listStacks();
        if (names.length === 0) {
          log.info("No stacks defined");
          return;
        }
        for (const name of names) {
          const stack = loadStack(name);
          if (stack) {
            const hostCount = stack.hosts.length;
            const fleetCount = stack.fleets.length;
            log.info(`  ${cyan(name)}  ${dim(`${hostCount} host(s), ${fleetCount} fleet(s)`)}`);
          }
        }
      })
      .command("show <name>", "Display stack details", (y) =>
        y.positional("name", { type: "string", demandOption: true, describe: "Stack name" }),
      (argv) => {
        const stack = requireStack(argv.name as string);
        printStackSummary(stack);
      })
      .command("edit <name>", "Edit a stack", (y) =>
        y
          .positional("name", { type: "string", demandOption: true, describe: "Stack name" })
          .option("fleet", { type: "string", describe: "Jump straight to a fleet's daemon settings" }),
      (argv) => handleEdit(argv.name as string, argv.fleet as string | undefined))
      .command("rm <name>", "Delete a stack, or remove the daemon from a fleet's hosts (--fleet)", (y) =>
        y
          .positional("name", { type: "string", demandOption: true, describe: "Stack name" })
          .option("fleet", { type: "string", describe: "Remove the daemon from this fleet's hosts instead of deleting the stack" }),
      (argv) => {
        const fleetName = argv.fleet as string | undefined;
        return fleetName
          ? handleRmFleet(argv.name as string, fleetName)
          : handleRm(argv.name as string);
      })
      .command("up <name>", "Plan and apply the whole stack at its pinned version", (y) =>
        y
          .positional("name", { type: "string", demandOption: true, describe: "Stack name" })
          .option("target-version", {
            describe: "Pin the stack to this release and deploy it (defaults to the stack's pinned version)",
            type: "string",
          }),
      (argv) => handleUp(argv.name as string, argv["target-version"] as string | undefined))
      .command(["doctor <name>", "status <name>"], "Health check the stack's hosts", (y) =>
        y
          .positional("name", { type: "string", demandOption: true, describe: "Stack name" })
          .option("fleet", { type: "string", describe: "Only check this fleet's hosts" }),
      (argv) => handleDoctor(argv.name as string, argv.fleet as string | undefined))
      .demandCommand(1, "Specify a stack action")
      .strict(),
  handler: () => {},
};
