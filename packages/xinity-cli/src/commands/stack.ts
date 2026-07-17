import type { CommandModule } from "yargs";
import { intro, outro, cancel, note, log, confirm, text, multiselect } from "../lib/clack.ts";
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
  validateStackName,
  getFleet,
  getFleetForHost,
  hostLabel,
  claimFleetHosts,
  pruneFleetMembership,
} from "../lib/stack.ts";
import { editSharedLayer, editComponentLayer, editFleetLayer } from "../lib/stack-layers.ts";
import { searchSelect, searchMultiselect, listSelect, type SearchListOption } from "../lib/search-list.ts";
import { runStackFlow } from "../lib/stack-plan.ts";
import { runDoctor, buildSummaryLine, type DoctorReport } from "../lib/doctor.ts";
import { fetchRelease, listReleases, type ReleaseListEntry } from "../lib/github.ts";
import { loadStackState, findOrphanHosts } from "../lib/stack-state.ts";
import { connectHosts, disposeAll, mapBounded, HOST_CONCURRENCY } from "../lib/multi-host.ts";

const AVAILABLE_COMPONENTS: Component[] = ["gateway", "dashboard", "daemon", "infoserver"];

// ── Helpers ──────────────────────────────────────────────────────────────

// Shell completion runs the yargs builder with these choices; outside of it
// they stay off so unknown names hit our own error messages, and `init`
// keeps accepting fresh names.
const completing = process.argv.includes("--get-yargs-completions");

function stackNameChoices(): { choices?: string[] } {
  return completing ? { choices: listStacks() } : {};
}

function fleetNameChoices(): { choices?: string[] } {
  if (!completing) {
    return {};
  }
  const words = process.argv.slice(process.argv.indexOf("stack") + 1).filter((w) => w && !w.startsWith("-"));
  const stack = words[1] ? loadStack(words[1]) : null;
  return stack ? { choices: stack.fleets.map((f) => f.name) } : {};
}

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
    log.warn("Could not reach the release registry");
    return null;
  }
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
    if (!values || Object.keys(values).length === 0) {
      continue;
    }
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

  const nameError = validateStackName(name);
  if (nameError) {
    log.error(`Invalid stack name: ${nameError}`);
    process.exit(1);
  }

  intro(`xinity stack init ${cyan(name)}`);

  // New stacks pin the latest release; re-pinning happens in stack edit.
  const latest = await resolveLatestTag();
  if (!latest) {
    log.error("A release version is required to create a stack");
    outro("Failed");
    process.exit(1);
  }
  const stack = createStack(name, latest);
  log.info(`Release version: ${cyan(latest)} (every component is held at this version)`);

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
    // Fetched in the background so the version menu opens without waiting.
    const releasesPromise: Promise<ReleaseListEntry[]> = listReleases().catch(() => []);

    // Escape at the top level behaves like Save & exit: submenu edits are
    // already applied in memory and must not be discarded silently.
    while (true) {
      const choice = await promptOrUndefined(listSelect({
        message: "What would you like to edit?",
        transient: true,
        options: [
          { value: "shared", label: `Shared settings (${Object.keys(stack.env).length + Object.keys(stack.secrets).length} set)` },
          { value: "component", label: "Component settings (stack-wide per type)" },
          { value: "version", label: `Release version (${stack.pinnedVersion})` },
          { value: "hosts", label: `Hosts (${stack.hosts.length})` },
          { value: "fleets", label: `Fleets (${stack.fleets.length})` },
          { value: "save", label: green("Save & exit") },
        ],
      }));

      if (choice === undefined || choice === "save") {
        break;
      }
      if (choice === "shared") {
        await editSharedLayer(stack);
      } else if (choice === "component") {
        await editComponentSettings(stack);
      } else if (choice === "version") {
        await editPinnedVersion(stack, releasesPromise);
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

function promptManualVersion(stack: StackDefinition): Promise<string | undefined> {
  return promptOrUndefined(text({
    message: "Stack release version",
    defaultValue: stack.pinnedVersion,
    placeholder: "vX.Y.Z",
  }));
}

async function editPinnedVersion(stack: StackDefinition, releasesPromise: Promise<ReleaseListEntry[]>): Promise<void> {
  const releases = await releasesPromise;
  let version: string | undefined;
  if (releases.length === 0) {
    // Registry unreachable (or no releases yet): manual entry is all we have.
    version = await promptManualVersion(stack);
  } else {
    const latestStable = releases.find((r) => !r.prerelease)?.tagName;
    const markers = (tag: string, prerelease: boolean) => [
      tag === latestStable ? cyan("(latest)") : "",
      prerelease ? yellow("(prerelease)") : "",
      tag === stack.pinnedVersion ? green("(pinned)") : "",
    ].filter(Boolean);
    // The manual-entry option is an object so it can never collide with a tag.
    const options: SearchListOption<string | { manual: true }>[] = releases.map((r) => ({
      value: r.tagName,
      label: [r.tagName, ...markers(r.tagName, r.prerelease)].join(" "),
    }));
    if (!releases.some((r) => r.tagName === stack.pinnedVersion)) {
      options.push({ value: stack.pinnedVersion, label: `${stack.pinnedVersion} ${green("(pinned)")}` });
    }
    options.push({ value: { manual: true }, label: dim("Enter a version manually") });

    const choice = await promptOrUndefined(searchSelect({
      message: "Stack release version",
      transient: true,
      options,
    }));
    if (choice === undefined) {
      return;
    }
    version = typeof choice === "string" ? choice : await promptManualVersion(stack);
  }
  if (version && version !== stack.pinnedVersion) {
    stack.pinnedVersion = version;
    log.success(`Pinned version set to ${cyan(version)}`);
  }
}

async function editComponentSettings(stack: StackDefinition): Promise<void> {
  const component = await promptOrUndefined(listSelect({
    message: "Which component type?",
    transient: true,
    options: AVAILABLE_COMPONENTS.map((c) => {
      const count = Object.keys(stack.componentEnv[c] ?? {}).length;
      return { value: c, label: `${c}${count > 0 ? dim(` (${count} set)`) : ""}` };
    }),
  }));
  if (component) {
    await editComponentLayer(stack, component);
  }
}

/**
 * Fleet membership is exclusive: hosts already in another fleet sort to the
 * bottom, dimmed and marked; selecting one moves it into this fleet.
 */
function fleetHostOptions(stack: StackDefinition, fleet: FleetDefinition | null) {
  const free: { value: string; label: string; hint?: string }[] = [];
  const taken: { value: string; label: string; hint?: string }[] = [];
  for (const host of stack.hosts) {
    if (!host.components.includes("daemon")) {
      continue;
    }
    const owner = getFleetForHost(stack, host.address);
    if (owner && owner !== fleet) {
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

function claimFleetHostsLogged(stack: StackDefinition, fleet: FleetDefinition, members: string[]): void {
  for (const emptied of claimFleetHosts(stack, fleet, members)) {
    log.warn(`Fleet "${emptied}" lost its last host and was removed`);
  }
}

async function hostsMenu(stack: StackDefinition): Promise<void> {
  while (true) {
    // Hosts are the option values themselves, so the add/back entries can
    // never collide with an address.
    const choice = await promptOrUndefined(searchSelect<StackHost | "add" | "back">({
      message: "Hosts",
      transient: true,
      options: [
        ...stack.hosts.map((h) => ({
          value: h,
          label: hostLabel(h),
          hint: h.components.join(", "),
        })),
        { value: "add", label: cyan("+ Add a host") },
        { value: "back", label: dim("Back") },
      ],
    }));

    if (choice === undefined || choice === "back") {
      return;
    }
    if (choice === "add") {
      await addHostInteractive(stack);
      continue;
    }
    await hostMenu(stack, choice);
  }
}

async function hostMenu(stack: StackDefinition, host: StackHost): Promise<void> {
  while (true) {
    const choice = await promptOrUndefined(listSelect({
      message: `Hosts > ${hostLabel(host)}`,
      transient: true,
      options: [
        { value: "components", label: `Components (${host.components.join(", ") || yellow("none")})` },
        { value: "alias", label: `Alias (${host.alias ?? "not set"})` },
        { value: "remove", label: red("Remove this host from the stack") },
        { value: "back", label: dim("Back") },
      ],
    }));

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
        message: `Remove ${hostLabel(host)} from the stack? (the next stack up uninstalls its components)`,
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
    // Fleets are the option values themselves, so the add/back entries can
    // never collide with a fleet name.
    const choice = await promptOrUndefined(listSelect<FleetDefinition | "add" | "back">({
      message: "Fleets",
      transient: true,
      options: [
        ...stack.fleets.map((f) => ({
          value: f,
          label: f.name,
          hint: f.hosts.join(", "),
        })),
        { value: "add", label: cyan("+ Add a fleet") },
        { value: "back", label: dim("Back") },
      ],
    }));

    if (choice === undefined || choice === "back") {
      return;
    }
    if (choice === "add") {
      const fleet = await addFleetInteractive(stack);
      if (fleet) {
        // A fleet's daemon settings belong to the moment it is created;
        // saving the editor untouched keeps the stack-wide baseline.
        await editFleetLayer(stack, fleet);
      }
      continue;
    }
    await fleetMenu(stack, choice);
  }
}

async function fleetMenu(stack: StackDefinition, fleet: FleetDefinition): Promise<void> {
  while (true) {
    const choice = await promptOrUndefined(listSelect({
      message: `Fleets > ${fleet.name}`,
      transient: true,
      options: [
        { value: "settings", label: `Daemon settings (${Object.keys(fleet.envOverrides ?? {}).length} override(s))` },
        { value: "hosts", label: `Hosts (${fleet.hosts.join(", ") || yellow("none")})` },
        { value: "remove", label: red("Remove this fleet") },
        { value: "back", label: dim("Back") },
      ],
    }));

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
        claimFleetHostsLogged(stack, fleet, members);
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
  claimFleetHostsLogged(stack, fleet, members);
  log.success(`Fleet "${fleetName}" created with ${members.length} host(s)`);
  return fleet;
}

// ── Up ───────────────────────────────────────────────────────────────────

async function handleUp(name: string, versionFlag: string | undefined, dryRun: boolean): Promise<void> {
  const stack = requireStack(name);
  intro(`xinity stack up ${cyan(name)}${dryRun ? yellow(" (dry run)") : ""}`);

  // The stack is held at its pinned version; updates only on express intent
  // (the --target-version flag, or re-pinning in stack edit).
  let targetVersion: string;
  if (versionFlag) {
    try {
      targetVersion = (await fetchRelease(versionFlag)).tagName;
    } catch (err) {
      log.error(`Could not resolve version ${versionFlag}: ${(err as Error).message}`);
      outro("Failed");
      process.exit(1);
    }
    if (!dryRun) {
      stack.pinnedVersion = targetVersion;
      saveStack(stack);
    }
  } else {
    targetVersion = stack.pinnedVersion;
  }
  log.info(`Stack version: ${cyan(targetVersion)}`);

  const ok = await runStackFlow(stack, { targetVersion, dryRun });
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
    // Checks are collected on all hosts at once (runDoctor stays silent when
    // non-interactive) and rendered afterwards in host order.
    type DoctorEntry = { address: string; report: DoctorReport } | { address: string; error: string };
    const reports = await mapBounded([...hosts.entries()], HOST_CONCURRENCY, async ([address, host]): Promise<DoctorEntry> => {
      try {
        return { address, report: await runDoctor({ host, interactive: false }) };
      } catch (err) {
        return { address, error: err instanceof Error ? err.message : String(err) };
      }
    });

    for (const entry of reports) {
      heading(entry.address);
      if ("error" in entry) {
        log.error(entry.error);
        totalFailed++;
        continue;
      }
      totalFailed += entry.report.summary.fail;
      for (const component of entry.report.components) {
        for (const check of component.checks) {
          if (check.status === "fail") {
            fail(`${component.component} · ${check.label}`, check.message);
          } else if (check.status === "warn") {
            warn(`${component.component} · ${check.label}`, check.message);
          }
        }
      }
      log.info(buildSummaryLine(entry.report.summary));
    }
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

  // Deleting the definition also deletes the state, so hosts not yet
  // evacuated by an up run would be forgotten; the listing makes that visible.
  const orphans = findOrphanHosts(loadStackState(name), stack);
  if (stack.hosts.length > 0 || orphans.length > 0) {
    log.info(bold("Tracked hosts:"));
    for (const host of stack.hosts) {
      log.info(`  ${host.address}: ${host.components.join(", ")}`);
    }
    for (const address of orphans) {
      log.info(`  ${address}: ${dim("removed from the definition, not yet evacuated")}`);
    }
    log.info("Hosts stay untouched. To uninstall components first, remove the hosts from the stack and run stack up before deleting it.");
  }

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
        y.positional("name", { type: "string", demandOption: true, describe: "Stack name", ...stackNameChoices() }),
      (argv) => {
        const stack = requireStack(argv.name as string);
        printStackSummary(stack);
      })
      .command("edit <name>", "Edit a stack", (y) =>
        y
          .positional("name", { type: "string", demandOption: true, describe: "Stack name", ...stackNameChoices() })
          .option("fleet", { type: "string", describe: "Jump straight to a fleet's daemon settings", ...fleetNameChoices() }),
      (argv) => handleEdit(argv.name as string, argv.fleet as string | undefined))
      .command("rm <name>", "Delete a stack definition", (y) =>
        y
          .positional("name", { type: "string", demandOption: true, describe: "Stack name", ...stackNameChoices() }),
      (argv) => handleRm(argv.name as string))
      .command("up <name>", "Plan and apply the whole stack at its pinned version", (y) =>
        y
          .positional("name", { type: "string", demandOption: true, describe: "Stack name", ...stackNameChoices() })
          .option("target-version", {
            describe: "Pin the stack to this release and deploy it (defaults to the stack's pinned version)",
            type: "string",
          })
          .option("dry-run", {
            describe: "Show the planned actions without applying them",
            type: "boolean",
            default: false,
          }),
      (argv) => handleUp(argv.name as string, argv["target-version"] as string | undefined, argv["dry-run"] as boolean))
      .command(["doctor <name>", "status <name>"], "Health check the stack's hosts", (y) =>
        y
          .positional("name", { type: "string", demandOption: true, describe: "Stack name", ...stackNameChoices() })
          .option("fleet", { type: "string", describe: "Only check this fleet's hosts", ...fleetNameChoices() }),
      (argv) => handleDoctor(argv.name as string, argv.fleet as string | undefined))
      .demandCommand(1, "Specify a stack action")
      .strict(),
  handler: () => {},
};
