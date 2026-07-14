/**
 * Stack definitions: declarative multi-host deployments stored locally.
 *
 * Configuration is layered, most general first, later layers win:
 * schema defaults → shared env/secrets → per-component-type settings →
 * fleet overrides (daemon only) → per-host overrides. Values live at the
 * highest level possible; per-host settings are the escape hatch, not the
 * norm.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { z } from "zod";
import { secret } from "common-env";
import { version as cliVersion } from "../../../../package.json";
import { type Component, getAutoDefaults } from "./component-meta.ts";
import { analyzeEnvSchema } from "./env-prompt.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface StackDefinition {
  /** CLI version that last wrote this file; lets future versions migrate breaking changes. */
  version: string;
  name: string;
  /** Shared, inherited by every component (DB_CONNECTION_URL, INFOSERVER_URL, ...). */
  env: Record<string, string>;
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

const CONFIG_DIR = join(homedir(), ".config", "xinity");
const STACKS_DIR = join(CONFIG_DIR, "stacks");

function stackPath(name: string): string {
  return join(STACKS_DIR, `${name}.json`);
}

// ── Persistence ──────────────────────────────────────────────────────────

function ensureStacksDir(): void {
  mkdirSync(STACKS_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STACKS_DIR, 0o700);
}

export function loadStack(name: string): StackDefinition | null {
  const path = stackPath(name);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<StackDefinition>;
    return { ...createStack(name), version: "0.0.0", ...parsed };
  } catch {
    return null;
  }
}

export function saveStack(stack: StackDefinition): void {
  ensureStacksDir();
  const path = stackPath(stack.name);
  stack.version = cliVersion;
  writeFileSync(path, JSON.stringify(stack, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function deleteStack(name: string): boolean {
  const path = stackPath(name);
  if (!existsSync(path)) {
    return false;
  }
  unlinkSync(path);
  return true;
}

export function listStacks(): string[] {
  if (!existsSync(STACKS_DIR)) {
    return [];
  }
  return readdirSync(STACKS_DIR)
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

// ── Env resolution ───────────────────────────────────────────────────────

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
    ...getAutoDefaults(component),
    ...stack.env,
    ...stack.secrets,
    ...(stack.componentEnv[component] ?? {}),
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
