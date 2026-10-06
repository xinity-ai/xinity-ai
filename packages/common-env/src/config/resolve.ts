import type { z } from "zod";
import { readSecretFile, type SecretFileReader } from "../secret-file";
import { checkGroupActivation, isGroupActive, type ActivationWarning } from "./activation";
import { fieldRefs, groupAt, pointerOf, refFor, type AnyConfig, type ConfigDef, type ConfigViolation, type FieldRef } from "./declaration";
import { isGroup, type AnyGroup, type ConfigEntry } from "./group";

export type ValueSource = "env" | "env-file" | "default" | "dynamic";

export type Provenance = {
  readonly pointer: string;
  readonly envKey: string;
  readonly source: ValueSource;
  readonly isSecret: boolean;
  readonly origin?: string;
};

export type ResolveOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly delegated?: readonly string[];
  readonly readSecretFile?: SecretFileReader;
};

export type Resolved<T> = {
  readonly value: T;
  readonly provenance: readonly Provenance[];
  readonly warnings: readonly ActivationWarning[];
};

export type ConfigProblem = {
  readonly fields: readonly FieldRef[];
  readonly message: string;
};

type RawValue =
  | { readonly source: "env"; readonly value: string }
  | { readonly source: "env-file"; readonly path: string };

function findRaw(entry: ConfigEntry, opts: ResolveOptions): RawValue | undefined {
  const env = opts.env ?? {};

  const direct = env[entry.envKey];
  if (direct !== undefined && direct !== "") {
    return { source: "env", value: direct };
  }

  const indirect = env[`${entry.envKey}_FILE`];
  if (indirect) {
    return { source: "env-file", path: indirect };
  }

  return undefined;
}

function readRaw(entry: ConfigEntry, raw: RawValue, read: SecretFileReader): unknown {
  return raw.source === "env-file"
    ? read(raw.path, entry.envKey)
    : raw.value;
}

function problemsFromIssues(
  issues: readonly z.core.$ZodIssue[],
  within: readonly ConfigEntry[],
): ConfigProblem[] {
  return issues.map((issue) => {
    const name = issue.path[0];
    const entry = within.find((candidate) => candidate.path[candidate.path.length - 1] === name);
    const target = entry ?? within[0];
    return {
      fields: target ? [refFor(target)] : [{ envKey: String(name ?? ""), pointer: "(root)" }],
      message: issue.message,
    };
  });
}

function withoutDelegatedFields(
  violations: readonly ConfigViolation[],
  delegated: ReadonlySet<string>,
): ConfigProblem[] {
  return violations.filter((violation) => !violation.fields.some((field) => delegated.has(field.envKey)));
}

function groupViolations(
  config: AnyConfig,
  key: string,
  group: AnyGroup,
  settled: Record<string, unknown>,
): ConfigViolation[] {
  return (group.violations?.(settled) ?? []).map((violation) => ({
    fields: [refFor(entryAt(config, [key, violation.field]))],
    message: violation.message,
  }));
}

type Parsed = {
  readonly value: Record<string, unknown>;
  readonly problems: readonly ConfigProblem[];
  readonly rawValues: ReadonlyMap<string, RawValue>;
  readonly warnings: readonly ActivationWarning[];
};

function parseConfig(config: AnyConfig, opts: ResolveOptions): Parsed {
  const rawValues = new Map<string, RawValue>();
  const presence: Record<string, unknown> = {};

  for (const entry of config.entries) {
    const found = findRaw(entry, opts);
    if (found) {
      rawValues.set(entry.envKey, found);
      presence[entry.envKey] = true;
    }
  }

  const activation = checkGroupActivation(config, presence);
  const delegated = new Set(opts.delegated ?? []);
  const read = opts.readSecretFile ?? readSecretFile;
  const value: Record<string, unknown> = {};
  const problems: ConfigProblem[] = [];

  for (const [key, member] of Object.entries(config.members)) {
    if (!isGroup(member)) {
      const entry = entryAt(config, [key]);
      const found = rawValues.get(member.envKey);
      const parsed = member.schema.safeParse(found ? readRaw(entry, found, read) : undefined);
      if (parsed.success) {
        value[key] = parsed.data;
      } else {
        problems.push(...problemsFromIssues(parsed.error.issues, [entry]));
      }
      continue;
    }

    if (!isGroupActive(activation, key)) {
      value[key] = undefined;
      continue;
    }

    const mounted = groupAt(config, key)!;
    const input: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(member.fields)) {
      const found = rawValues.get(field.envKey);
      if (found) {
        input[name] = readRaw(entryAt(config, [key, name]), found, read);
      }
    }

    const parsed = mounted.schema.safeParse(input);
    if (parsed.success) {
      value[key] = parsed.data;
      problems.push(...withoutDelegatedFields(groupViolations(config, key, member, parsed.data), delegated));
    } else {
      problems.push(...problemsFromIssues(parsed.error.issues, mounted.entries));
    }
  }

  // Only on a complete value: a rule reads members a failed one would have left undefined.
  if (problems.length === 0 && config.violations) {
    problems.push(...withoutDelegatedFields(config.violations(value, fieldRefs(config)), delegated));
  }

  return { value, problems, rawValues, warnings: activation.warnings };
}

export function checkConfig(config: AnyConfig, opts: ResolveOptions = {}): readonly ConfigProblem[] {
  return parseConfig(config, opts).problems;
}

export function configError(problems: readonly ConfigProblem[]): Error {
  const lines = problems.map((p) => {
    const keys = p.fields.map((field) => field.envKey).join(", ");
    const pointers = p.fields.map((field) => field.pointer).join(", ");
    return `  - ${keys} (${pointers}): ${p.message}`;
  });
  return new Error(`Invalid configuration:\n${lines.join("\n")}`);
}

export type ConfigValues = Record<string, unknown>;

/** A list leaf re-parses into a fresh array, so identity would report every resolve as a change. */
export function sameConfigValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  return a.every((item, index) => sameConfigValue(item, b[index]));
}

export type ResolvedValues = {
  readonly values: ConfigValues;
  readonly problems: readonly ConfigProblem[];
  readonly provenance: readonly Provenance[];
  readonly warnings: readonly ActivationWarning[];
};

export function resolveValues(config: AnyConfig, opts: ResolveOptions = {}): ResolvedValues {
  const { value, problems, rawValues, warnings } = parseConfig(config, opts);

  const provenance = config.entries.map((entry): Provenance => {
    const found = rawValues.get(entry.envKey);
    return {
      pointer: pointerOf(entry),
      envKey: entry.envKey,
      source: found?.source ?? "default",
      isSecret: entry.isSecret,
      origin: found?.source === "env-file" ? found.path : undefined,
    };
  });

  return { values: value, problems, provenance, warnings };
}

export function withDynamicAccessors<T>(config: AnyConfig, readCurrentValues: () => ConfigValues): T {
  const projected: ConfigValues = {};

  for (const [key, member] of Object.entries(config.members)) {
    if (!isGroup(member)) {
      projected[key] = member.isDynamic
        ? () => readCurrentValues()[key]
        : readCurrentValues()[key];
      continue;
    }

    const groupValue = readCurrentValues()[key] as ConfigValues | undefined;
    if (groupValue === undefined) {
      projected[key] = undefined;
      continue;
    }

    const fields: ConfigValues = {};
    for (const [name, field] of Object.entries(member.fields)) {
      fields[name] = field.isDynamic
        ? () => (readCurrentValues()[key] as ConfigValues)[name]
        : groupValue[name];
    }
    projected[key] = fields;
  }

  return projected as T;
}

export function resolveConfig<T>(config: ConfigDef<T>, opts: ResolveOptions = {}): Resolved<T> {
  const { values, problems, provenance, warnings } = resolveValues(config, opts);

  if (problems.length > 0) {
    throw configError(problems);
  }

  return { value: withDynamicAccessors<T>(config, () => values), provenance, warnings };
}

export function configFromProcessEnv<T>(config: ConfigDef<T>): T {
  return resolveConfig(config, { env: process.env }).value;
}

function entryAt(config: AnyConfig, path: readonly string[]): ConfigEntry {
  const pointer = path.join(".");
  const entry = config.entryByPointer.get(pointer);
  if (!entry) {
    throw new Error(`No config entry at ${pointer}`);
  }
  return entry;
}
