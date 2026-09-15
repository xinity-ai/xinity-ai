import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeConfig, type EnvField } from "common-env";
import { COMPONENTS, COMPONENT_CONFIGS, type Component } from "../packages/xinity-cli/src/lib/component-meta.ts";

const ROOT = resolve(import.meta.dirname, "..");
const START_MARKER = "<!-- [sync:config] - generated from the config declaration, do not edit -->";
const END_MARKER = "<!-- [/sync:config] -->";

const PACKAGE_DIRS: Record<Component, string> = {
  gateway: "packages/xinity-ai-gateway",
  dashboard: "packages/xinity-ai-dashboard",
  daemon: "packages/xinity-ai-daemon",
  infoserver: "packages/xinity-infoserver",
  tether: "packages/xinity-tether",
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

function render(component: Component): string {
  const fields = analyzeConfig(COMPONENT_CONFIGS[component]);
  return [START_MARKER, "", ...sections(fields), END_MARKER].join("\n");
}

let missing = 0;
for (const component of COMPONENTS) {
  const path = join(ROOT, PACKAGE_DIRS[component], "README.md");
  const readme = readFileSync(path, "utf-8");
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);

  if (start === -1 || end === -1) {
    console.error(`Missing sync markers in ${PACKAGE_DIRS[component]}/README.md`);
    missing++;
    continue;
  }

  const updated = readme.slice(0, start) + render(component) + readme.slice(end + END_MARKER.length);
  if (updated === readme) {
    console.log(`OK: ${PACKAGE_DIRS[component]}/README.md`);
    continue;
  }
  writeFileSync(path, updated);
  console.log(`Updated: ${PACKAGE_DIRS[component]}/README.md`);
}

if (missing > 0) {
  process.exit(1);
}
