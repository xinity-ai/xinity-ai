import type { z } from "zod";
import { readSecretFile } from "../secret-file";
import { checkGroupActivation, isGroupActive, type ActivationWarning } from "./activation";
import { groupAt, type ConfigDef, type AnyConfig } from "./build";
import { isGroup, type ConfigEntry } from "./group";

export type ValueSource = "env" | "env-file" | "file" | "default";

export type Provenance = {
  readonly pointer: string;
  readonly envKey: string;
  readonly source: ValueSource;
  readonly isSecret: boolean;
  readonly origin?: string;
};

export type ResolveOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly file?: unknown;
  readonly fileOrigin?: string;
};

export type Resolved<T> = {
  readonly value: T;
  readonly provenance: readonly Provenance[];
  readonly warnings: readonly ActivationWarning[];
};

type Located = {
  readonly source: Exclude<ValueSource, "default">;
  readonly raw: unknown;
  readonly origin?: string;
};

function readPath(source: unknown, path: readonly string[]): unknown {
  let cursor: unknown = source;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function locate(entry: ConfigEntry, opts: ResolveOptions): Located | undefined {
  const env = opts.env ?? {};

  const direct = env[entry.envKey];
  if (direct !== undefined && direct !== "") {
    return { source: "env", raw: direct };
  }

  const indirect = env[`${entry.envKey}_FILE`];
  if (indirect) {
    return { source: "env-file", raw: indirect, origin: indirect };
  }

  const fromFile = readPath(opts.file, entry.path);
  if (fromFile !== undefined && fromFile !== null) {
    return { source: "file", raw: fromFile, origin: opts.fileOrigin };
  }

  return undefined;
}

// KEY_FILE is the only indirection. A config file carries values, never references to them.
function materialize(entry: ConfigEntry, located: Located): unknown {
  return located.source === "env-file"
    ? readSecretFile(String(located.raw), entry.envKey)
    : located.raw;
}

function describeIssues(issues: readonly z.core.$ZodIssue[], within: readonly ConfigEntry[]): string[] {
  return issues.map((issue) => {
    const name = issue.path[0];
    const entry = within.find((candidate) => candidate.path[candidate.path.length - 1] === name);
    const target = entry ?? within[0];
    const label = target ? `${target.envKey} (${target.path.join(".")})` : String(name ?? "(root)");
    return `  - ${label}: ${issue.message}`;
  });
}

export function resolveConfig<T>(config: ConfigDef<T>, opts: ResolveOptions = {}): Resolved<T> {
  const located = new Map<string, Located>();
  const presence: Record<string, unknown> = {};

  for (const entry of config.entries) {
    const found = locate(entry, opts);
    if (found) {
      located.set(entry.envKey, found);
      presence[entry.envKey] = found.raw;
    }
  }

  const activation = checkGroupActivation(config, presence);
  const value: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [key, member] of Object.entries(config.members)) {
    if (!isGroup(member)) {
      const entry = entryAt(config, [key]);
      const found = located.get(member.envKey);
      const parsed = member.schema.safeParse(found ? materialize(entry, found) : undefined);
      if (parsed.success) {
        value[key] = parsed.data;
      } else {
        problems.push(...describeIssues(parsed.error.issues, [entry]));
      }
      continue;
    }

    if (!isGroupActive(activation, key)) {
      value[key] = undefined;
      continue;
    }

    const mounted = groupAt(config, key)!;
    const entries = config.entries.filter((entry) => entry.path[0] === key);
    const input: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(member.fields)) {
      const found = located.get(field.envKey);
      if (found) {
        input[name] = materialize(entryAt(config, [key, name]), found);
      }
    }

    const parsed = mounted.schema.safeParse(input);
    if (parsed.success) {
      value[key] = parsed.data;
    } else {
      problems.push(...describeIssues(parsed.error.issues, entries));
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }

  const provenance = config.entries.map((entry): Provenance => {
    const found = located.get(entry.envKey);
    return {
      pointer: entry.path.join("."),
      envKey: entry.envKey,
      source: found?.source ?? "default",
      isSecret: entry.isSecret,
      origin: found?.origin,
    };
  });

  return { value: value as T, provenance, warnings: activation.warnings };
}

function entryAt(config: AnyConfig, path: readonly string[]): ConfigEntry {
  const pointer = path.join(".");
  const entry = config.entries.find((candidate) => candidate.path.join(".") === pointer);
  if (!entry) {
    throw new Error(`No config entry at ${pointer}`);
  }
  return entry;
}
