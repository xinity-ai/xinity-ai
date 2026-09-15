import { z } from "zod";
import {
  activationKeys,
  fieldEntry,
  groupEntries,
  isGroup,
  type AnyField,
  type AnyGroup,
  type ConfigEntry,
  type ConfigField,
  type Settled,
  type GroupDef,
} from "./group";

declare const CONFIG_VALUE: unique symbol;

export type AnyMember = AnyField | AnyGroup;

type ConfigMember<V> = ConfigField<V> | GroupDef<V>;
type Members<T> = { [K in keyof T]-?: ConfigMember<T[K]> };

export type MountedGroup = {
  readonly key: string;
  readonly group: AnyGroup;
  /** Parses the group's fields, once activation has decided the group is present. */
  readonly schema: z.ZodObject<z.ZodRawShape>;
  /** Env keys whose presence decides activation. Empty when the group is not optional. */
  readonly activation: readonly string[];
};

export type FieldRef = {
  readonly envKey: string;
  readonly pointer: string;
  readonly groupTitle?: string;
};

/** Mirrors the config shape, with a reference where each value would be. */
export type FieldRefs<T> = {
  readonly [K in keyof T]-?: NonNullable<T[K]> extends readonly unknown[]
    ? FieldRef
    : NonNullable<T[K]> extends (...args: never[]) => unknown
      ? FieldRef
      : NonNullable<T[K]> extends object
        ? FieldRefs<NonNullable<T[K]>>
        : FieldRef;
};

export type ConfigViolation = { fields: readonly FieldRef[]; message: string };

export type AnyConfig = {
  readonly members: Readonly<Record<string, AnyMember>>;
  readonly entries: readonly ConfigEntry[];
  readonly groups: readonly MountedGroup[];
  readonly violations?: (value: unknown, at: unknown) => readonly ConfigViolation[];
};

export type ConfigDef<T = unknown> = AnyConfig & { readonly [CONFIG_VALUE]: (value: T) => T };

type SettledMembers<T> = {
  [K in keyof T]: T[K] extends () => infer V
    ? V
    : NonNullable<T[K]> extends object
      ? Settled<NonNullable<T[K]>> | Extract<T[K], undefined>
      : T[K];
};

type ConfigInput<T> = {
  violations?: (value: SettledMembers<T>, at: FieldRefs<T>) => readonly ConfigViolation[];
};

export function refFor(entry: ConfigEntry): FieldRef {
  return { envKey: entry.envKey, pointer: entry.path.join("."), groupTitle: entry.groupTitle };
}

export function fieldRefs(config: AnyConfig): unknown {
  const root: Record<string, unknown> = {};
  for (const entry of config.entries) {
    let node = root;
    for (const segment of entry.path.slice(0, -1)) {
      node[segment] ??= {};
      node = node[segment] as Record<string, unknown>;
    }
    node[entry.path[entry.path.length - 1]!] = refFor(entry);
  }
  return root;
}

export function defineConfig<T>(members: Members<T>, opts: ConfigInput<T> = {}): ConfigDef<T> {
  const mounted = members as Readonly<Record<string, AnyMember>>;

  const entries: ConfigEntry[] = [];
  const groups: MountedGroup[] = [];

  for (const [key, member] of Object.entries(mounted)) {
    if (!isGroup(member)) {
      entries.push(fieldEntry([key], member));
      continue;
    }
    for (const entry of groupEntries(member)) {
      entries.push({ ...entry, path: [key, ...entry.path] });
    }
    groups.push({
      key,
      group: member,
      schema: groupObjectSchema(member),
      activation: activationKeys(member),
    });
  }

  const seen = new Map<string, string>();
  for (const entry of entries) {
    const pointer = entry.path.join(".");
    const clash = seen.get(entry.envKey);
    if (clash) {
      throw new Error(`${entry.envKey} is read by both ${clash} and ${pointer}`);
    }
    seen.set(entry.envKey, pointer);
  }

  return {
    members: mounted,
    entries,
    groups,
    violations: opts.violations as AnyConfig["violations"],
  } as unknown as ConfigDef<T>;
}

function groupObjectSchema(group: AnyGroup): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(group.fields)) {
    shape[name] = field.schema;
  }

  const object = z.object(shape);
  const violations = group.violations;
  if (!violations) {
    return object;
  }

  return object.check((ctx) => {
    for (const violation of violations(ctx.value)) {
      ctx.issues.push({ code: "custom", input: ctx.value, path: [violation.field], message: violation.message });
    }
  });
}

export function entryFor(config: AnyConfig, envKey: string): ConfigEntry | undefined {
  return config.entries.find((entry) => entry.envKey === envKey);
}

export function groupAt(config: AnyConfig, key: string): MountedGroup | undefined {
  return config.groups.find((group) => group.key === key);
}
