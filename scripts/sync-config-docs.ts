import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { analyzeConfig, deprecations, removals, type EnvField } from "common-env";
import { COMPONENTS, COMPONENT_CONFIGS, getAutoDefaults, type Component } from "../packages/xinity-cli/src/lib/core/component-meta.ts";
import { componentFields } from "../packages/xinity-cli/src/lib/config/env-prompt.ts";
import { REQUIRED_IN_EVERY_STACK, STACK_SHARED_KEYS, stackDefinitionT } from "../packages/xinity-cli/src/lib/stack/stack.ts";

const ROOT = resolve(import.meta.dirname, "..");
const START_MARKER = "<!-- [sync:config] - generated from the config declaration, do not edit -->";
const END_MARKER = "<!-- [/sync:config] -->";
const NIX_START_MARKER = "# [sync:dynamic-keys] - generated from the config declaration, do not edit";
const NIX_END_MARKER = "# [/sync:dynamic-keys]";
const TS_START_MARKER = "// [sync:dynamic-keys] - generated from the config declaration, do not edit";
const TS_END_MARKER = "// [/sync:dynamic-keys]";
const DEPRECATIONS_START_MARKER = "<!-- [sync:deprecations] - generated from the deprecation registry, do not edit -->";
const DEPRECATIONS_END_MARKER = "<!-- [/sync:deprecations] -->";

const PACKAGE_DIRS: Record<Component, string> = {
  gateway: "packages/xinity-ai-gateway",
  dashboard: "packages/xinity-ai-dashboard",
  daemon: "packages/xinity-ai-daemon",
  infoserver: "packages/xinity-infoserver",
  tether: "packages/xinity-tether",
};

const NIX_MODULES: Record<Component, string> = {
  gateway: "nix/modules/xinity-ai-gateway.mod.nix",
  dashboard: "nix/modules/xinity-ai-dashboard.mod.nix",
  daemon: "nix/modules/xinity-ai-daemon.mod.nix",
  infoserver: "nix/modules/xinity-infoserver.mod.nix",
  tether: "nix/modules/xinity-tether.mod.nix",
};

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function defaultCell(field: EnvField): string {
  if (field.isRequiredBySchema) return "(required)";
  if (!field.hasDefault) return "(unset)";
  const value = field.defaultValue;
  return Array.isArray(value) && value.length === 0 ? "(empty)" : `\`${cell(String(value))}\``;
}

function describe(field: EnvField): string {
  const text = (field.description ?? "").trim();
  const notes = [
    text && !/[.!?]$/.test(text) ? `${text}.` : text,
    field.enumValues ? `One of ${field.enumValues.map((v) => `\`${v}\``).join(", ")}.` : "",
    field.isSecret ? "Secret." : "",
    field.isDynamic ? "Can be set to `@dynamic` to take its value from the dashboard." : "",
  ];
  return cell(notes.filter(Boolean).join(" "));
}

function table(fields: EnvField[]): string[] {
  return [
    "| Variable | Default | Description |",
    "|---|---|---|",
    ...fields.map((f) => `| \`${f.key}\` | ${defaultCell(f)} | ${describe(f)} |`),
  ];
}

/** Groups in declaration order, ungrouped keys last, so the page reads like the declaration. */
function sections(fields: EnvField[]): string[] {
  const ungrouped = fields.filter((f) => !f.group);
  const groupIds = [...new Set(fields.filter((f) => f.group).map((f) => f.group!.id))];

  const lines: string[] = [];
  for (const id of groupIds) {
    const members = fields.filter((f) => f.group?.id === id);
    const group = members[0]!.group!;
    lines.push(`### ${group.title}`, "");
    if (group.description) lines.push(group.description, "");
    const [only] = group.activation;
    if (group.activation.length === 1) {
      lines.push(`Off unless \`${only}\` is set.`, "");
    } else if (group.activation.length > 1) {
      lines.push(`Off unless all of ${group.activation.map((k) => `\`${k}\``).join(", ")} are set.`, "");
    }
    lines.push(...table(members), "");
  }
  if (ungrouped.length > 0) {
    lines.push("### Other", "", ...table(ungrouped), "");
  }
  return lines;
}

function nixKeyList(keys: string[]): string[] {
  return ["dashboardManageableKeys = [", ...keys.map((key) => `  "${key}"`), "];"];
}

/** The tether forwards these to every daemon, so it has to know them without importing the daemon. */
const TETHER_DAEMON_KEYS = "packages/xinity-tether/src/daemon-config-keys.ts";

function tsKeyList(keys: string[]): string[] {
  return [
    "export const DAEMON_DYNAMIC_KEYS: readonly string[] = [",
    ...keys.map((key) => `  "${key}",`),
    "];",
  ];
}

function deprecationTable(): string[] {
  const pending = Object.entries(deprecations).sort(([, a], [, b]) => a.deprecatedSince.localeCompare(b.deprecatedSince));
  const removed = Object.entries(removals).sort(([, a], [, b]) => Bun.semver.order(b.removedIn, a.removedIn));
  return [
    "| Removed in | Deprecated since | ID | What changes |",
    "|---|---|---|---|",
    ...pending.map(([id, d]) => `|  | ${d.deprecatedSince} | \`${id}\` | ${cell(d.summary)}. |`),
    ...removed.map(([id, r]) => `| ${r.removedIn} | ${r.deprecatedSince ?? ""} | \`${id}\` | ${cell(r.summary)}. |`),
  ];
}

function sync(relPath: string, start: string, end: string, render: (indent: string) => string): boolean {
  const path = join(ROOT, relPath);
  const text = readFileSync(path, "utf-8");
  const from = text.indexOf(start);
  const to = text.indexOf(end);

  if (from === -1 || to === -1) {
    console.error(`Missing sync markers in ${relPath}`);
    return false;
  }

  const indent = text.slice(text.lastIndexOf("\n", from) + 1, from);
  const updated = text.slice(0, from) + render(indent) + text.slice(to + end.length);
  if (updated === text) {
    console.log(`OK: ${relPath}`);
    return true;
  }
  writeFileSync(path, updated);
  console.log(`Updated: ${relPath}`);
  return true;
}

const STACK_SCHEMA_PATH = "deployment/cli/stack.schema.json";
const STACK_SCHEMA_URL = `https://raw.githubusercontent.com/xinity-ai/xinity-ai/main/${STACK_SCHEMA_PATH}`;

type JsonSchema = { [key: string]: unknown };

function requirement(field: EnvField, installDefault: string | undefined): string {
  if (installDefault !== undefined || !(field.requiredOverride ?? field.isRequiredBySchema)) return "";
  const activation = field.group?.activation ?? [];
  const others = activation.filter((key) => key !== field.key);
  if (activation.length === 0) return "Required.";
  return others.length === 0 ? "" : `Required when ${others.map((key) => `\`${key}\``).join(" or ")} is set.`;
}

function defaultOf(field: EnvField, installDefault: string | undefined): string | undefined {
  if (installDefault !== undefined) return installDefault;
  const plain = field.hasDefault && !field.isRequiredBySchema && ["string", "number", "boolean"].includes(typeof field.defaultValue);
  return plain ? String(field.defaultValue) : undefined;
}

function keyProperty(field: EnvField, notes: string[], defaultValue: string | undefined): JsonSchema {
  return {
    type: "string",
    description: [describe(field).replaceAll("\\|", "|"), ...notes].filter(Boolean).join(" "),
    ...(field.enumValues ? { enum: field.enumValues } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  };
}

function keyMap(description: unknown, properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", description, properties, additionalProperties: false };
}

const DERIVED_NOTES: Record<string, string> = {
  TETHER_URL: "Filled in from the host address when exactly one stack host runs the tether.",
  INFOSERVER_URL: "Filled in from the host address when a stack host runs the infoserver.",
};

function sharedKeyProperties(secret: boolean): Record<string, JsonSchema> {
  return Object.fromEntries([...STACK_SHARED_KEYS].flatMap((key) => {
    const declaring = COMPONENTS.filter((component) => componentFields(component).some((f) => f.key === key));
    const field = componentFields(declaring[0]!).find((f) => f.key === key)!;
    if (field.isSecret !== secret) {
      return [];
    }
    const requiring = declaring.filter((component) =>
      requirement(componentFields(component).find((f) => f.key === field.key)!, undefined) !== "");
    const notes = [
      `Used by ${declaring.join(", ")}.`,
      REQUIRED_IN_EVERY_STACK.has(field.key) ? "Required in every stack." : "",
      !REQUIRED_IN_EVERY_STACK.has(field.key) && requiring.length > 0 ? `Required by ${requiring.join(", ")}.` : "",
      DERIVED_NOTES[field.key] ?? "",
    ];
    return [[field.key, keyProperty(field, notes, defaultOf(field, undefined))]];
  }));
}

function componentOwnFields(component: Component): EnvField[] {
  return componentFields(component).filter((field) => !STACK_SHARED_KEYS.has(field.key));
}

function componentKeyProperties(component: Component): Record<string, JsonSchema> {
  const installDefaults: Record<string, string> = getAutoDefaults(component);
  return Object.fromEntries(componentOwnFields(component).map((field) => {
    const installDefault = installDefaults[field.key];
    return [field.key, keyProperty(field, [requirement(field, installDefault)], defaultOf(field, installDefault))];
  }));
}

// A key several components declare has no single default or requirement, so it names them instead.
function hostKeyProperties(): Record<string, JsonSchema> {
  const properties: Record<string, JsonSchema> = {};
  for (const component of COMPONENTS) {
    for (const [key, property] of Object.entries(componentKeyProperties(component))) {
      properties[key] ??= property;
    }
  }
  for (const key of Object.keys(properties)) {
    const declaring = COMPONENTS.filter((component) => componentOwnFields(component).some((field) => field.key === key));
    if (declaring.length > 1) {
      const field = componentOwnFields(declaring[0]!).find((f) => f.key === key)!;
      properties[key] = keyProperty(field, [`Used by ${declaring.join(", ")}, each with its own default.`], undefined);
    }
  }
  return properties;
}

function stackSchema(): string {
  const schema = z.toJSONSchema(stackDefinitionT, { io: "input" }) as JsonSchema & { properties: Record<string, JsonSchema> };
  const { properties } = schema;
  const hostItems = (properties.hosts!.items as JsonSchema & { properties: Record<string, JsonSchema> }).properties;
  const fleetItems = (properties.fleets!.items as JsonSchema & { properties: Record<string, JsonSchema> }).properties;

  properties.env = keyMap(properties.env!.description, sharedKeyProperties(false));
  properties.secrets = keyMap(properties.secrets!.description, sharedKeyProperties(true));
  properties.componentEnv = keyMap(
    properties.componentEnv!.description,
    Object.fromEntries(COMPONENTS.map((component) => [component, keyMap(`Values for every ${component} host.`, componentKeyProperties(component))])),
  );
  hostItems.envOverrides = keyMap(hostItems.envOverrides!.description, hostKeyProperties());
  fleetItems.envOverrides = keyMap(fleetItems.envOverrides!.description, componentKeyProperties("daemon"));

  return JSON.stringify({ $id: STACK_SCHEMA_URL, title: "Xinity stack", ...schema }, null, 2) + "\n";
}

function syncGenerated(relPath: string, content: string): boolean {
  const path = join(ROOT, relPath);
  if (existsSync(path) && readFileSync(path, "utf-8") === content) {
    console.log(`OK: ${relPath}`);
    return true;
  }
  writeFileSync(path, content);
  console.log(`Updated: ${relPath}`);
  return true;
}

let synced = true;
for (const component of COMPONENTS) {
  const fields = analyzeConfig(COMPONENT_CONFIGS[component]);

  synced =
    sync(join(PACKAGE_DIRS[component], "README.md"), START_MARKER, END_MARKER, () =>
      [START_MARKER, "", ...sections(fields), END_MARKER].join("\n"),
    ) && synced;

  const dynamicKeys = fields.filter((f) => f.isDynamic).map((f) => f.key);
  if (dynamicKeys.length > 0) {
    synced =
      sync(NIX_MODULES[component], NIX_START_MARKER, NIX_END_MARKER, (indent) =>
        [NIX_START_MARKER, ...nixKeyList(dynamicKeys), NIX_END_MARKER].join(`\n${indent}`),
      ) && synced;
  }

  if (component === "daemon") {
    synced =
      sync(TETHER_DAEMON_KEYS, TS_START_MARKER, TS_END_MARKER, () =>
        [TS_START_MARKER, ...tsKeyList(dynamicKeys), TS_END_MARKER].join("\n"),
      ) && synced;
  }
}

synced =
  sync("docs/deprecations.md", DEPRECATIONS_START_MARKER, DEPRECATIONS_END_MARKER, () =>
    [DEPRECATIONS_START_MARKER, "", ...deprecationTable(), "", DEPRECATIONS_END_MARKER].join("\n"),
  ) && synced;

synced = syncGenerated(STACK_SCHEMA_PATH, stackSchema()) && synced;

if (!synced) {
  process.exit(1);
}
