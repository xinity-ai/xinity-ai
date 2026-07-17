/**
 * Stack definitions: declarative multi-host deployments stored locally.
 *
 * Configuration is layered, most general first, later layers win:
 * schema defaults → shared env/secrets → per-component-type settings →
 * fleet overrides (daemon only) → per-host overrides. Values live at the
 * highest level possible; per-host settings are the escape hatch, not the
 * norm.
 */
import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { xinityConfigDir, loadPrivateJson, savePrivateJson } from "./config.ts";
import { z } from "zod";
import { secret } from "common-env";
import { version as cliVersion } from "../../../../package.json";
import { type Component, getAutoDefaults } from "./component-meta.ts";
import { analyzeEnvSchema } from "./env-prompt.ts";
import { deleteStackState } from "./stack-state.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface StackDefinition {
  /** CLI version that last wrote this file; lets future versions migrate breaking changes. */
  version: string;
  name: string;
  /** Shared, inherited by every component (DB_CONNECTION_URL, INFOSERVER_URL, ...). */
  env: Record<string, string>;
  /**
   * Values derived for the current run (e.g. INFOSERVER_URL from the
   * infoserver host's address). Sits below `env` so explicit values win,
   * and is never persisted so it re-derives when the stack changes.
   */
  derivedEnv?: Record<string, string>;
  secrets: Record<string, string>;
  /** Stack-wide settings per component type (gateway PORT vs dashboard PORT don't collide here). */
  componentEnv: Partial<Record<Component, Record<string, string>>>;
  /** Release tag whose migrations were last applied to the stack's database. */
  dbMigratedVersion?: string;
  /** The release every component is held at; updated only on explicit request. */
  pinnedVersion?: string;
  hosts: StackHost[];
  fleets: FleetDefinition[];
}

export interface StackHost {
  alias?: string;
  address: string;
  components: Component[];
  envOverrides?: Record<string, string>;
}

export interface FleetDefinition {
  name: string;
  hosts: string[];
  envOverrides?: Record<string, string>;
}

export function hostLabel(host: StackHost): string {
  return host.alias ? `${host.alias} (${host.address})` : host.address;
}

/** Shared infra values collected at `stack init`; everything else lives in component/fleet layers. */
export const STACK_SHARED_SCHEMA = z.object({
  DB_CONNECTION_URL: z.url().describe("PostgreSQL connection string shared by all components").meta(secret()),
  REDIS_URL: z.url().describe("Redis connection URL shared by all components").meta(secret()),
  INFOSERVER_URL: z.url().optional().describe("Infoserver URL (hosted default: https://sysinfo.xinity.ai; leave unset when the stack hosts its own)"),
  METRICS_AUTH: z.string().describe("Basic auth for every component's /metrics endpoint (user:pass, comma-separated for multiple)").meta(secret()),
  HF_TOKEN: z.string().optional().describe("Hugging Face token for gated model downloads").meta(secret()),
});

/** Owned by the shared layer; component/fleet/host editors must not offer them. */
export const STACK_SHARED_KEYS: Set<string> = new Set(Object.keys(STACK_SHARED_SCHEMA.shape));

/** Write a shared-settings editor result back, honoring deletions of optional keys. */
export function applySharedResult(
  stack: StackDefinition,
  result: { config: Record<string, string>; secrets: Record<string, string> },
): void {
  for (const field of analyzeEnvSchema(STACK_SHARED_SCHEMA)) {
    const bucket = field.isSecret ? stack.secrets : stack.env;
    const value = field.isSecret ? result.secrets[field.key] : result.config[field.key];
    if (value === undefined) {
      delete bucket[field.key];
    } else {
      bucket[field.key] = value;
    }
  }
}

/** True when the stack runs its own infoserver (configured or placed on a host), so INFOSERVER_URL is derived, never asked. */
export function stackHostsInfoserver(stack: StackDefinition): boolean {
  return stack.componentEnv.infoserver !== undefined
    || stack.hosts.some((h) => h.components.includes("infoserver"));
}

/** Shared-schema keys the shared editor must not offer for this stack. */
export function sharedHiddenKeys(stack: StackDefinition): Set<string> | undefined {
  return stackHostsInfoserver(stack) ? new Set(["INFOSERVER_URL"]) : undefined;
}

// ── Paths ────────────────────────────────────────────────────────────────

function stacksDir(): string {
  return join(xinityConfigDir(), "stacks");
}

function stackPath(name: string): string {
  return join(stacksDir(), `${name}.json`);
}

// ── Persistence ──────────────────────────────────────────────────────────

export function loadStack(name: string): StackDefinition | null {
  const parsed = loadPrivateJson<Partial<StackDefinition>>(stackPath(name));
  if (!parsed) {
    return null;
  }
  return { ...createStack(name), version: "0.0.0", ...parsed };
}

export function saveStack(stack: StackDefinition): void {
  stack.version = cliVersion;
  const { derivedEnv: _, ...persisted } = stack;
  savePrivateJson(stackPath(stack.name), persisted);
}

export function deleteStack(name: string): boolean {
  const path = stackPath(name);
  if (!existsSync(path)) {
    return false;
  }
  unlinkSync(path);
  deleteStackState(name);
  return true;
}

export function listStacks(): string[] {
  if (!existsSync(stacksDir())) {
    return [];
  }
  return readdirSync(stacksDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

// ── Lookup ───────────────────────────────────────────────────────────────

export function getFleet(stack: StackDefinition, fleetName: string): FleetDefinition | null {
  return stack.fleets.find((f) => f.name === fleetName) ?? null;
}

export function getHost(stack: StackDefinition, address: string): StackHost | null {
  return stack.hosts.find((h) => h.address === address) ?? null;
}

export function getFleetForHost(stack: StackDefinition, address: string): FleetDefinition | null {
  return stack.fleets.find((f) => f.hosts.includes(address)) ?? null;
}

// ── Fleet membership ─────────────────────────────────────────────────────

/** Assign members to a fleet, pulling any that belonged to other fleets. Returns the names of fleets removed because they lost their last host. */
export function claimFleetHosts(stack: StackDefinition, fleet: FleetDefinition, members: string[]): string[] {
  const claimed = new Set(members);
  fleet.hosts = members;
  const emptied: string[] = [];
  for (const other of stack.fleets) {
    if (other === fleet) {
      continue;
    }
    const remaining = other.hosts.filter((a) => !claimed.has(a));
    if (remaining.length === 0 && other.hosts.length > 0) {
      emptied.push(other.name);
    }
    other.hosts = remaining;
  }
  stack.fleets = stack.fleets.filter((f) => f.hosts.length > 0);
  return emptied;
}

/** Hosts no longer running a daemon can't stay fleet members. */
export function pruneFleetMembership(stack: StackDefinition, address: string): void {
  for (const fleet of stack.fleets) {
    fleet.hosts = fleet.hosts.filter((a) => a !== address);
  }
  stack.fleets = stack.fleets.filter((f) => f.hosts.length > 0);
}

// ── Env resolution ───────────────────────────────────────────────────────
// One layer order, used by both the editors (base/seed) and the deploy
// (resolveEnv): schema auto defaults → derived → shared env → shared
// secrets → component type → fleet (daemon only) → host.

export function componentLayerBase(stack: StackDefinition, component: Component): Record<string, string> {
  return { ...getAutoDefaults(component), ...(stack.derivedEnv ?? {}), ...stack.env, ...stack.secrets };
}

export function componentLayerSeed(stack: StackDefinition, component: Component): Record<string, string> {
  return { ...componentLayerBase(stack, component), ...(stack.componentEnv[component] ?? {}) };
}

export function fleetLayerBase(stack: StackDefinition): Record<string, string> {
  return componentLayerSeed(stack, "daemon");
}

export function fleetLayerSeed(stack: StackDefinition, fleet: FleetDefinition): Record<string, string> {
  return { ...fleetLayerBase(stack), ...(fleet.envOverrides ?? {}) };
}

/**
 * The stack's declared configuration for one component on one host.
 * Fleets are a daemon concept; their overrides don't leak into other
 * components that happen to share the host.
 */
export function resolveEnv(
  stack: StackDefinition,
  component: Component,
  hostAddress?: string,
): Record<string, string> {
  const host = hostAddress ? getHost(stack, hostAddress) : null;
  const fleet = component === "daemon" && hostAddress ? getFleetForHost(stack, hostAddress) : null;
  return {
    ...componentLayerSeed(stack, component),
    ...(fleet?.envOverrides ?? {}),
    ...(host?.envOverrides ?? {}),
  };
}

/** Keep only entries that differ from the base layer, so stored overrides stay minimal. */
export function diffFromLayer(
  values: Record<string, string>,
  base: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (base[key] !== value) {
      out[key] = value;
    }
  }
  return out;
}

// ── Validation ───────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

export function validateStack(stack: StackDefinition): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!stack.name || !/^[a-z0-9][a-z0-9_-]*$/.test(stack.name)) {
    errors.push({ field: "name", message: "Must be lowercase alphanumeric with hyphens/underscores, starting with a letter or digit" });
  }

  const hostAddresses = new Set(stack.hosts.map((h) => h.address));

  if (hostAddresses.size !== stack.hosts.length) {
    errors.push({ field: "hosts", message: "Duplicate host addresses" });
  }

  for (const host of stack.hosts) {
    if (!host.address) {
      errors.push({ field: "hosts", message: "Host address must not be empty" });
    }
    if (host.components.length === 0) {
      errors.push({ field: "hosts", message: `Host ${host.address} has no components assigned` });
    }
  }

  const fleetNames = new Set<string>();
  const fleetOf = new Map<string, string>();
  for (const fleet of stack.fleets) {
    if (!fleet.name) {
      errors.push({ field: "fleets", message: "Fleet name must not be empty" });
      continue;
    }
    if (fleetNames.has(fleet.name)) {
      errors.push({ field: "fleets", message: `Duplicate fleet name: ${fleet.name}` });
    }
    fleetNames.add(fleet.name);

    let hasDaemonHost = false;
    for (const hostAddr of fleet.hosts) {
      const owner = fleetOf.get(hostAddr);
      if (owner) {
        errors.push({ field: "fleets", message: `Host ${hostAddr} is in multiple fleets ("${owner}", "${fleet.name}"); a host belongs to at most one fleet` });
      } else {
        fleetOf.set(hostAddr, fleet.name);
      }
      if (!hostAddresses.has(hostAddr)) {
        errors.push({ field: "fleets", message: `Fleet "${fleet.name}" references unknown host: ${hostAddr}` });
      }
      if (getHost(stack, hostAddr)?.components.includes("daemon")) {
        hasDaemonHost = true;
      }
    }
    if (!hasDaemonHost && fleet.hosts.length > 0) {
      errors.push({ field: "fleets", message: `Fleet "${fleet.name}" has no hosts with the daemon component` });
    }
  }

  return errors;
}

// ── Factory ──────────────────────────────────────────────────────────────

export function createStack(name: string): StackDefinition {
  return {
    version: cliVersion,
    name,
    env: {},
    secrets: {},
    componentEnv: {},
    hosts: [],
    fleets: [],
  };
}
