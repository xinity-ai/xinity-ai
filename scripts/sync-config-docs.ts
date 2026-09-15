import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeConfig, type EnvField } from "common-env";
import { COMPONENTS, COMPONENT_CONFIGS, type Component } from "../packages/xinity-cli/src/lib/component-meta.ts";

const ROOT = resolve(import.meta.dirname, "..");
const START_MARKER = "<!-- [sync:config] - generated from the config declaration, do not edit -->";
const END_MARKER = "<!-- [/sync:config] -->";
const NIX_START_MARKER = "# [sync:dynamic-keys] - generated from the config declaration, do not edit";
const NIX_END_MARKER = "# [/sync:dynamic-keys]";

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
    if (group.activation.length > 0) {
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
}

if (!synced) {
  process.exit(1);
}
