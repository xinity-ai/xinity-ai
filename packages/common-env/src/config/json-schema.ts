import { z } from "zod";
import { fileFormOf } from "./leaf-types";
import { isGroup, isRequiredLeaf, type AnyGroup, type ConfigEntry } from "./group";
import type { AnyConfig } from "./build";

type Node = Record<string, unknown>;

// Zod copies .meta() into its output, so our own markers would surface as JSON Schema keywords.
const MARKERS = ["secret", "expert", "public", "fileSchema"];

function leafNode(entry: ConfigEntry): Node {
  const node = { ...(z.toJSONSchema(fileFormOf(entry.schema), { io: "input" }) as Node) };

  delete node.$schema;
  for (const marker of MARKERS) {
    delete node[marker];
  }
  // z.int() reports the JS safe-integer range, which is noise in a config file.
  if (node.minimum === Number.MIN_SAFE_INTEGER) {
    delete node.minimum;
  }
  if (node.maximum === Number.MAX_SAFE_INTEGER) {
    delete node.maximum;
  }

  const withDefault = entry.schema.safeParse(undefined);
  if (withDefault.success && withDefault.data !== undefined) {
    node.default = withDefault.data;
  }

  const description = [
    entry.description,
    entry.isExpert ? "(advanced)" : undefined,
    entry.isSecret ? `Secret: prefer ${entry.envKey}_FILE.` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  if (description) {
    node.description = description;
  }

  return node;
}

function groupNode(group: AnyGroup, entries: readonly ConfigEntry[]): Node {
  const properties: Node = {};
  const required: string[] = [];

  for (const name of Object.keys(group.fields)) {
    const entry = entries.find((candidate) => candidate.path[candidate.path.length - 1] === name);
    if (!entry) {
      continue;
    }
    properties[name] = leafNode(entry);
    if (isRequiredLeaf(entry)) {
      required.push(name);
    }
  }

  return {
    type: "object",
    title: group.title,
    ...(group.description ? { description: group.description } : {}),
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export function toConfigJsonSchema(config: AnyConfig, opts: { id: string; title: string }): unknown {
  const properties: Node = {};
  const required: string[] = [];

  for (const [key, member] of Object.entries(config.members)) {
    const entries = config.entries.filter((entry) => entry.path[0] === key);

    if (!isGroup(member)) {
      const entry = entries[0];
      if (!entry) {
        continue;
      }
      properties[key] = leafNode(entry);
      if (isRequiredLeaf(entry)) {
        required.push(key);
      }
      continue;
    }

    const node = groupNode(member, entries);
    properties[key] = node;
    // An optional group is absent-or-complete, so requiring its members only bites once it exists.
    if (!member.optional && Array.isArray(node.required) && node.required.length > 0) {
      required.push(key);
    }
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: opts.id,
    title: opts.title,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
