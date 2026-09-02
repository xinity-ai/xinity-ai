import type { z } from "zod";
import { readLeafMeta } from "./leaf-types";

declare const RESOLVED: unique symbol;

// Invariant, and required rather than optional: an optional phantom makes V and V | undefined
// identical, which would let a schema that never produces a value satisfy a required field.
type Resolves<V> = { readonly [RESOLVED]: (value: V) => V };

// Unbranded, so anything walking the declaration accepts a field or group of any declared type.
export type AnyField = {
  readonly envKey: string;
  readonly schema: z.ZodType;
};

export type ConfigField<V = unknown> = AnyField & Resolves<V>;

export function env<S extends z.ZodType>(envKey: string, schema: S): ConfigField<z.output<S>> {
  return { envKey, schema } as unknown as ConfigField<z.output<S>>;
}

type Fields<T> = { [K in keyof T]-?: ConfigField<T[K]> };

type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];

const GROUP = Symbol.for("xinity.config.group");

export type AnyGroup = {
  readonly [GROUP]: true;
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly expert?: boolean;
  readonly optional?: { readonly requires: readonly string[] };
  readonly fields: Readonly<Record<string, AnyField>>;
};

export type GroupDef<V = unknown> = AnyGroup & Resolves<V>;

type GroupInput<T> = {
  id: string;
  title: string;
  description?: string;
  /** Marks every field advanced, so they need not repeat it. */
  expert?: boolean;
  fields: Fields<T>;
};

/** Overloads rather than a conditional return: supplying T explicitly stops TS inferring anything else. */
export function defineGroup<T>(def: GroupInput<T> & { optional?: never }): GroupDef<T>;
export function defineGroup<T>(
  def: GroupInput<T> & { optional: { requires: readonly RequiredKeys<T>[] } },
): GroupDef<T | undefined>;
export function defineGroup<T>(
  def: GroupInput<T> & { optional?: { requires: readonly string[] } },
): GroupDef<T | undefined> {
  const fields = def.fields as Readonly<Record<string, AnyField>>;

  const seen = new Map<string, string>();
  for (const [name, field] of Object.entries(fields)) {
    const clash = seen.get(field.envKey);
    if (clash) {
      throw new Error(`Group "${def.id}" reads ${field.envKey} for both ${clash} and ${name}`);
    }
    seen.set(field.envKey, name);
  }

  if (def.optional) {
    const { requires } = def.optional;
    if (requires.length === 0) {
      throw new Error(`Group "${def.id}" is optional but requires nothing, so it can never activate`);
    }
    for (const name of requires) {
      if (!(name in fields)) {
        throw new Error(`Group "${def.id}" requires "${name}", which is not one of its fields`);
      }
    }
  }

  return {
    [GROUP]: true,
    id: def.id,
    title: def.title,
    description: def.description,
    expert: def.expert,
    optional: def.optional,
    fields,
  } as GroupDef<T | undefined>;
}

export function isGroup(member: unknown): member is AnyGroup {
  return typeof member === "object" && member !== null && GROUP in member;
}

export type ConfigEntry = {
  /** Path to the value, relative to whatever the entry is collected from. */
  readonly path: readonly string[];
  readonly envKey: string;
  readonly schema: z.ZodType;
  readonly description?: string;
  readonly isSecret: boolean;
  readonly isExpert: boolean;
  readonly groupId?: string;
  readonly groupTitle?: string;
};

export function fieldEntry(path: readonly string[], field: AnyField, group?: AnyGroup): ConfigEntry {
  const meta = readLeafMeta(field.schema);
  return {
    path,
    envKey: field.envKey,
    schema: field.schema,
    description: typeof meta.description === "string" ? meta.description : undefined,
    isSecret: meta.secret === true,
    isExpert: group?.expert === true || meta.expert === true,
    groupId: group?.id,
    groupTitle: group?.title,
  };
}

export function isRequiredLeaf(entry: ConfigEntry): boolean {
  return !entry.schema.safeParse(undefined).success;
}

export function groupEntries(group: AnyGroup): ConfigEntry[] {
  return Object.entries(group.fields).map(([name, field]) => fieldEntry([name], field, group));
}

export function activationKeys(group: AnyGroup): string[] {
  return (group.optional?.requires ?? []).map((name) => {
    const field = group.fields[name];
    if (!field) {
      throw new Error(`Group "${group.id}" requires "${name}", which is not one of its fields`);
    }
    return field.envKey;
  });
}
