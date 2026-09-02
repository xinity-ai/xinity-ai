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

export type AnyConfig = {
  readonly members: Readonly<Record<string, AnyMember>>;
  readonly entries: readonly ConfigEntry[];
  readonly groups: readonly MountedGroup[];
};

export type ConfigDef<T = unknown> = AnyConfig & { readonly [CONFIG_VALUE]: (value: T) => T };

export function defineConfig<T>(members: Members<T>): ConfigDef<T> {
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

  return { members: mounted, entries, groups } as unknown as ConfigDef<T>;
}

function groupObjectSchema(group: AnyGroup): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(group.fields)) {
    shape[name] = field.schema;
  }
  return z.object(shape);
}

export function entryFor(config: AnyConfig, envKey: string): ConfigEntry | undefined {
  return config.entries.find((entry) => entry.envKey === envKey);
}

export function groupAt(config: AnyConfig, key: string): MountedGroup | undefined {
  return config.groups.find((group) => group.key === key);
}
