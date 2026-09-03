import { z } from "zod";
import { select, confirm, text, password, log, isCancel } from "./clack.ts";
import { bold, cyan, dim, yellow, green } from "picocolors";
import { promptOrExit, cancelAndExit } from "./output.ts";
import { parseEnvString } from "./env-file.ts";
import { fileFormOf, readLeafMeta, type AnyConfig } from "common-env";
import { type Component, COMPONENTS, COMPONENT_CONFIGS, DERIVED_ENV_KEYS, ENV_SCHEMAS, ENV_DIR, SECRETS_DIR } from "./component-meta.ts";
import { readSecrets, type Host } from "./host.ts";
import { readManifest } from "./manifest.ts";

export type EnvFieldGroup = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** Env keys whose presence activates the group. Empty when it is always present. */
  readonly activation: readonly string[];
};

export type EnvField = {
  key: string;
  description?: string;
  hasDefault: boolean;
  defaultValue?: unknown;
  isOptional: boolean;
  isRequired: boolean;
  isSecret: boolean;
  isExpert: boolean;
  isPublic: boolean;
  enumValues?: string[];
  isNumber: boolean;
  isBoolean: boolean;
  /** Only set for components on a grouped declaration. */
  group?: EnvFieldGroup;
}

function readFieldMeta(field: z.ZodType): { secret: boolean; expert: boolean; public: boolean } {
  const meta = z.globalRegistry.get(field);
  return {
    secret: meta?.secret === true,
    expert: meta?.expert === true,
    public: meta?.public === true,
  };
}

type JsonSchemaProp = {
  type?: string;
  enum?: string[];
  anyOf?: Array<{ type?: string; enum?: string[] }>;
  description?: string;
  default?: unknown;
};

function extractEnumValues(prop: JsonSchemaProp): string[] | undefined {
  return prop.enum ?? prop.anyOf?.find((a) => a.enum)?.enum;
}

function resolveJsonSchemaType(prop: JsonSchemaProp): string | undefined {
  if (!prop.anyOf) return prop.type;
  const nonNull = prop.anyOf.find((a) => a.type !== "null");
  return nonNull?.type ?? "string";
}

const schemaFieldCache = new WeakMap<z.ZodObject<any>, EnvField[]>();

/** Analyze a Zod env schema into structured field metadata. Cached per schema object. */
export function analyzeEnvSchema(
  schema: z.ZodObject<any>,
): EnvField[] {
  const cached = schemaFieldCache.get(schema);
  if (cached) {
    return cached;
  }
  const jsonSchema = z.toJSONSchema(schema) as {
    properties: Record<string, JsonSchemaProp>;
    required?: string[];
  };
  const requiredKeys = new Set(jsonSchema.required ?? []);

  const fields: EnvField[] = [];
  for (const [key, zodField] of Object.entries(schema.shape)) {
    const prop = jsonSchema.properties[key] ?? {};
    const meta = readFieldMeta(zodField as z.ZodType);
    const enumValues = extractEnumValues(prop);
    const resolvedType = resolveJsonSchemaType(prop);
    const hasDefault = "default" in prop;
    const isOptional = !requiredKeys.has(key);

    fields.push({
      key,
      description: prop.description,
      hasDefault,
      defaultValue: prop.default,
      isOptional,
      isRequired: !isOptional && !hasDefault,
      isSecret: meta.secret,
      isExpert: meta.expert,
      isPublic: meta.public,
      enumValues,
      isNumber: resolvedType === "number" || resolvedType === "integer",
      isBoolean: resolvedType === "boolean",
    });
  }

  schemaFieldCache.set(schema, fields);
  return fields;
}

const configFieldCache = new WeakMap<AnyConfig, EnvField[]>();

/** The same metadata, from a grouped declaration rather than a flat schema. */
export function analyzeConfig(config: AnyConfig): EnvField[] {
  const cached = configFieldCache.get(config);
  if (cached) {
    return cached;
  }

  const fields = config.entries.map((entry): EnvField => {
    const prop = z.toJSONSchema(fileFormOf(entry.schema), { io: "input" }) as JsonSchemaProp;
    const withoutValue = entry.schema.safeParse(undefined);
    const resolvedType = resolveJsonSchemaType(prop);
    const mounted = config.groups.find((candidate) => candidate.group.id === entry.groupId);

    return {
      key: entry.envKey,
      description: entry.description,
      hasDefault: withoutValue.success && withoutValue.data !== undefined,
      defaultValue: withoutValue.success ? withoutValue.data : undefined,
      isOptional: withoutValue.success,
      isRequired: !withoutValue.success,
      isSecret: entry.isSecret,
      isExpert: entry.isExpert,
      isPublic: readLeafMeta(entry.schema).public === true,
      enumValues: extractEnumValues(prop),
      isNumber: resolvedType === "number" || resolvedType === "integer",
      isBoolean: resolvedType === "boolean",
      group: mounted && {
        id: mounted.group.id,
        title: mounted.group.title,
        description: mounted.group.description,
        activation: mounted.activation,
      },
    };
  });

  configFieldCache.set(config, fields);
  return fields;
}

/** A component reads either way, so services can port one at a time. */
export function componentFields(component: Component): EnvField[] {
  const declared = COMPONENT_CONFIGS[component];
  return declared ? analyzeConfig(declared) : analyzeEnvSchema(ENV_SCHEMAS[component]!);
}

/** The single definition of "the config is invalid without this field". */
export function isRequiredUnset(field: EnvField, values: Record<string, string | undefined>): boolean {
  return field.isRequired && !values[field.key];
}

export function missingRequiredFields(fields: EnvField[], values: Record<string, string | undefined>): EnvField[] {
  return fields.filter((f) => isRequiredUnset(f, values));
}

export function categorizeFields(fields: EnvField[]): {
  configFields: EnvField[];
  secretFields: EnvField[];
} {
  return {
    configFields: fields.filter((f) => !f.isSecret),
    secretFields: fields.filter((f) => f.isSecret),
  };
}

function assignByCategory(
  field: EnvField,
  value: string,
  config: Record<string, string>,
  secrets: Record<string, string>,
): void {
  if (field.isSecret) secrets[field.key] = value;
  else config[field.key] = value;
}

/** Splits a flat values map into separate config and secret records based on each field's category. */
export function splitValuesByCategory(
  fields: EnvField[],
  values: Record<string, string | undefined>,
): { config: Record<string, string>; secrets: Record<string, string> } {
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of fields) {
    const val = values[field.key];
    if (val !== undefined) assignByCategory(field, val, config, secrets);
  }
  return { config, secrets };
}

export type EnvBundle = {
  config: Record<string, string>;
  secrets: Record<string, string>;
}

export function flattenBundle(bundle: EnvBundle): Record<string, string> {
  return { ...bundle.config, ...bundle.secrets };
}

export type EnvChange = {
  key: string;
  kind: "added" | "changed" | "removed";
  isSecret: boolean;
  before?: string;
  after?: string;
}

function withoutDerivedKeys(component: Component, config: Record<string, string>): Record<string, string> {
  const derived = DERIVED_ENV_KEYS[component];
  if (!derived) {
    return config;
  }
  return Object.fromEntries(Object.entries(config).filter(([key]) => !derived.includes(key)));
}

/**
 * What applying `after` would change relative to the values currently on the
 * host.
 */
export function diffEnv(component: Component, before: EnvBundle, after: EnvBundle): EnvChange[] {
  const changes: EnvChange[] = [];
  const compare = (prev: Record<string, string>, next: Record<string, string>, isSecret: boolean) => {
    for (const [key, value] of Object.entries(next)) {
      if (!(key in prev)) {
        changes.push({ key, kind: "added", isSecret, after: value });
      } else if (prev[key] !== value) {
        changes.push({ key, kind: "changed", isSecret, before: prev[key], after: value });
      }
    }
    for (const key of Object.keys(prev)) {
      if (!(key in next)) changes.push({ key, kind: "removed", isSecret });
    }
  };
  compare(withoutDerivedKeys(component, before.config), withoutDerivedKeys(component, after.config), false);
  compare(before.secrets, after.secrets, true);
  return changes;
}

function prefillFromExisting(
  fields: EnvField[],
  existing: Record<string, string> | undefined,
  config: Record<string, string>,
  secrets: Record<string, string>,
): void {
  for (const field of fields) {
    const val = existing?.[field.key];
    if (val !== undefined) assignByCategory(field, val, config, secrets);
  }
}

/**
 * Prompt the user for env values for a component.
 * Shows existing values as defaults when updating.
 *
 * Fields marked expert are silently set from
 * `existingValues` (which includes auto-defaults) and only shown if the user
 * opts into advanced settings at the end.
 *
 * Returns split { config, secrets } records ready for writing.
 */
export async function promptForEnv(
  component: string,
  fields: EnvField[],
  existingValues?: Record<string, string>,
  skipKeys?: Set<string>,
): Promise<{ config: Record<string, string>; secrets: Record<string, string> }> {
  const { configFields, secretFields } = categorizeFields(fields);
  const skip = skipKeys ?? new Set<string>();

  // Split into visible (essential), expert (advanced), and skipped
  const visibleConfig = configFields.filter((f) => !f.isExpert && !skip.has(f.key));
  const visibleSecrets = secretFields.filter((f) => !f.isExpert && !skip.has(f.key));
  const expertFields = fields.filter((f) => f.isExpert);
  const skippedFields = fields.filter((f) => skip.has(f.key) && !f.isExpert);

  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  prefillFromExisting([...expertFields, ...skippedFields], existingValues, config, secrets);

  await promptFieldsUnderHeading(visibleConfig, "Configuration", existingValues, config, secrets);
  await promptFieldsUnderHeading(visibleSecrets, "Secrets", existingValues, config, secrets);

  return { config, secrets };
}

async function promptFieldsUnderHeading(
  fields: EnvField[],
  heading: string,
  existingValues: Record<string, string> | undefined,
  config: Record<string, string>,
  secrets: Record<string, string>,
): Promise<void> {
  if (fields.length === 0) return;
  log.step(bold(heading));
  for (const field of fields) {
    const value = await promptField(field, existingValues?.[field.key]);
    if (value !== undefined && value !== FIELD_CANCELLED) assignByCategory(field, value, config, secrets);
  }
}

/** Distinguishes an Escape (back out, change nothing) from a skipped/cleared field. */
const FIELD_CANCELLED: unique symbol = Symbol("field-cancelled");

const UNSET_OPTION = "__unset__";

async function promptField(
  field: EnvField,
  existingValue?: string,
  inMenuEditor = false,
): Promise<string | undefined | typeof FIELD_CANCELLED> {
  const resolve = async <T>(prompt: Promise<T | symbol>): Promise<T | typeof FIELD_CANCELLED> => {
    const value = await prompt;
    if (isCancel(value)) {
      if (inMenuEditor) return FIELD_CANCELLED;
      cancelAndExit();
    }
    return value as T;
  };

  const hint = field.description ? dim(` (${field.description})`) : "";
  const optTag = field.isOptional ? dim(" [optional]") : "";
  const existing = existingValue ?? (field.hasDefault ? String(field.defaultValue) : undefined);
  // Only the menu editor can back out with Escape, so only there is an empty submit safe to read as "unset".
  const unsetOnEmpty = inMenuEditor && !field.isRequired;
  const emptyHint = existingValue === undefined
    ? ""
    : dim(unsetOnEmpty ? " [Enter to unset]" : " [Enter to keep current]");
  const keepOnEmpty = unsetOnEmpty ? undefined : existing;

  // Secret → masked password input
  if (field.isSecret) {
    const value = await resolve(password({
      message: `${field.key}${hint}${optTag}${emptyHint}`,
      validate: (val) => {
        if (!val && !existing && field.isRequired) return "This field is required";
        return undefined;
      },
    }));
    if (value === FIELD_CANCELLED) return value;
    return value || keepOnEmpty || undefined;
  }

  // Enum → select
  if (field.enumValues) {
    const options = field.enumValues.map((v) => ({ value: v, label: v }));
    if (!field.isRequired) {
      options.unshift({ value: UNSET_OPTION, label: dim(inMenuEditor ? "unset" : "skip") });
    }
    const value = await resolve(select({
      message: `${field.key}${hint}${optTag}`,
      options,
      initialValue: existing,
    }));
    if (value === FIELD_CANCELLED) return value;
    return value === UNSET_OPTION ? undefined : value;
  }

  // Boolean → confirm
  if (field.isBoolean) {
    const value = await resolve(confirm({
      message: `${field.key}${hint}`,
      initialValue: existingValue !== undefined
        ? existingValue === "true" || existingValue === "1"
        : field.hasDefault && field.defaultValue === true,
    }));
    if (value === FIELD_CANCELLED) return value;
    return String(value);
  }

  // Number or string → text input
  const value = await resolve(text({
    message: `${field.key}${hint}${optTag}${emptyHint}`,
    placeholder: existing ?? undefined,
    defaultValue: unsetOnEmpty ? undefined : existing ?? undefined,
    validate: (val) => {
      if (!val && !existing && field.isRequired) return "This field is required";
      if (val && field.isNumber && Number.isNaN(Number(val))) return "Must be a number";
      return undefined;
    },
  }));
  if (value === FIELD_CANCELLED) return value;
  return value || keepOnEmpty || undefined;
}

/** Format a field's current value for display in the menu. */
function displayValue(field: EnvField, value: string | undefined): string {
  if (value !== undefined && value !== "") {
    if (field.isSecret) return dim("••••••");
    return cyan(value);
  }
  if (field.hasDefault) return dim(`(default: ${field.defaultValue})`);
  if (field.isOptional) return dim("(not set)");
  return yellow("(not set)");
}

type MenuGroup = { definition: EnvFieldGroup; fields: EnvField[] };

const GROUP_PREFIX = " group:";
const GROUP_TITLE_WIDTH = 22;

const ADVANCED_THRESHOLD = 6;

/** Groups in the order their first key appears, so the declaration dictates the layout. */
function collectGroups(fields: EnvField[]): MenuGroup[] {
  const groups: MenuGroup[] = [];
  for (const field of fields) {
    if (!field.group) {
      continue;
    }
    const existing = groups.find((group) => group.definition.id === field.group!.id);
    if (existing) {
      existing.fields.push(field);
    } else {
      groups.push({ definition: field.group, fields: [field] });
    }
  }
  return groups;
}

type GroupState = "always" | "off" | "partial" | "on";

function groupState(group: MenuGroup, values: Record<string, string | undefined>): GroupState {
  const { activation } = group.definition;
  if (activation.length === 0) {
    return "always";
  }
  const present = activation.filter((key) => values[key] !== undefined && values[key] !== "").length;
  if (present === 0) {
    return "off";
  }
  return present === activation.length ? "on" : "partial";
}

function groupStatus(
  state: GroupState,
  missing: number,
  group: MenuGroup,
  values: Record<string, string | undefined>,
): string {
  if (state === "off") {
    return dim("off");
  }
  if (state === "partial") {
    return yellow("partially configured");
  }
  if (missing > 0) {
    return yellow(`${missing} required`);
  }
  const set = group.fields.filter((f) => values[f.key] !== undefined && values[f.key] !== "").length;
  return set > 0 ? green("configured") : dim("defaults");
}

function fieldMarker(field: EnvField, required: boolean, attentionKeys: Set<string>): string {
  if (required) {
    return yellow("● required ");
  }
  return attentionKeys.has(field.key) ? cyan("● review ") : "";
}

export type MenuEditOptions = {
  /** Keys highlighted for review: values worth a deliberate look, not enforced. */
  attentionKeys?: Set<string>;
  /** Keys owned by another layer (e.g. stack shared settings): not shown, not editable; their seeded values pass through. */
  hiddenKeys?: Set<string>;
  /** Message displayed above the menu. */
  message?: string;
}

/**
 * Menu-based env editor. Returns the merged { config, secrets } without
 * persisting anything. Returns null if the user cancels.
 *
 * Required fields are marked and block saving while unset. Expert fields
 * live behind the "advanced settings" toggle, set or not.
 */
export async function menuEditEnv(
  fields: EnvField[],
  existing: Record<string, string>,
  opts?: MenuEditOptions,
): Promise<{ config: Record<string, string>; secrets: Record<string, string> } | null> {
  const attentionKeys = opts?.attentionKeys ?? new Set<string>();
  const hiddenKeys = opts?.hiddenKeys ?? new Set<string>();
  const editable = fields.filter((f) => !hiddenKeys.has(f.key));
  const values: Record<string, string | undefined> = { ...existing };
  let showExpert = false;
  // Returning to the top after every edit means scrolling back down to the neighbouring key, which
  // is exactly the one you usually want next.
  let cursor: string | undefined;

  const requiredUnset = (f: EnvField) => isRequiredUnset(f, values);
  const isVisible = (f: EnvField, hideAdvanced: boolean) => !hideAdvanced || !f.isExpert || showExpert;

  const ungrouped = editable.filter((f) => !f.group);
  const groups = collectGroups(editable);

  const fieldOption = (field: EnvField) => ({
    value: field.key,
    label: `${fieldMarker(field, requiredUnset(field), attentionKeys)}${field.isExpert ? dim(field.key) : field.key}  ${displayValue(field, values[field.key])}`,
    hint: field.description,
  });

  const editField = async (field: EnvField): Promise<void> => {
    const newValue = await promptField(field, values[field.key], true);
    if (newValue === FIELD_CANCELLED) {
      return;
    }
    if (newValue !== undefined) {
      values[field.key] = newValue;
    } else {
      delete values[field.key];
    }
  };

  /** Turning a group on asks for exactly the keys that decide whether it is on. */
  const enableGroup = async (group: MenuGroup): Promise<void> => {
    for (const key of group.definition.activation) {
      const field = group.fields.find((candidate) => candidate.key === key);
      if (field) {
        await editField(field);
      }
    }
  };

  const editGroup = async (group: MenuGroup): Promise<void> => {
    let groupCursor: string | undefined;
    const hideAdvanced = group.fields.length > ADVANCED_THRESHOLD;
    while (true) {
      const visible = group.fields.filter((f) => isVisible(f, hideAdvanced));
      const options = visible.map(fieldOption);
      const hidden = group.fields.length - visible.length;
      if (hidden > 0 && !showExpert) {
        options.push({ value: "__expert__", label: dim(`Show advanced settings (${hidden} more)…`), hint: undefined });
      }
      if (group.definition.activation.length > 0 && groupState(group, values) !== "off") {
        options.push({ value: "__clear__", label: dim(`Turn off ${group.definition.title}`), hint: undefined });
      }
      options.push({ value: "__back__", label: green("Back"), hint: undefined });

      const choice = await select({
        message: group.definition.description
          ? `${bold(group.definition.title)} ${dim(group.definition.description)}`
          : bold(group.definition.title),
        options,
        initialValue: groupCursor,
      });
      if (isCancel(choice) || choice === "__back__") {
        return;
      }
      if (choice === "__expert__") {
        showExpert = true;
        continue;
      }
      if (choice === "__clear__") {
        for (const field of group.fields) {
          delete values[field.key];
        }
        return;
      }
      groupCursor = choice;
      await editField(group.fields.find((f) => f.key === choice)!);
    }
  };

  // A group is one row of navigation rather than an option, so it never counts towards the
  // threshold and is never hidden: its own view decides what to show once you are inside it.
  const hideAdvanced = ungrouped.length > ADVANCED_THRESHOLD;

  while (true) {
    const hiddenCount = ungrouped.filter((f) => !isVisible(f, hideAdvanced)).length;

    const options = ungrouped.filter((f) => isVisible(f, hideAdvanced)).map(fieldOption);

    for (const group of groups) {
      const missing = group.fields.filter(requiredUnset).length;
      options.push({
        value: `${GROUP_PREFIX}${group.definition.id}`,
        label: `${group.definition.title.padEnd(GROUP_TITLE_WIDTH)} ${groupStatus(groupState(group, values), missing, group, values)}`,
        hint: group.definition.description,
      });
    }

    if (hiddenCount > 0) {
      options.push({ value: "__expert__", label: dim(`Show advanced settings (${hiddenCount} more)…`), hint: undefined });
    } else if (showExpert && hideAdvanced && ungrouped.some((f) => f.isExpert)) {
      options.push({ value: "__expert__", label: dim("Hide advanced settings"), hint: undefined });
    }
    options.push({ value: "__save__", label: green("Save & exit"), hint: undefined });

    const choice = await select({
      message: opts?.message ?? "Select a value to update",
      options,
      initialValue: cursor,
    });

    if (isCancel(choice)) return null;

    if (choice === "__expert__") {
      showExpert = !showExpert;
      cursor = "__expert__";
      continue;
    }

    if (choice === "__save__") {
      const blocking = missingRequiredFields(editable, values);
      if (blocking.length > 0) {
        log.warn(
          `These variables are required and not set: ${blocking.map((f) => f.key).join(", ")}`,
        );
        continue;
      }
      break;
    }

    cursor = choice;

    if (choice.startsWith(GROUP_PREFIX)) {
      const group = groups.find((g) => `${GROUP_PREFIX}${g.definition.id}` === choice)!;
      if (groupState(group, values) === "off") {
        const enable = await confirm({ message: `Enable ${group.definition.title}?`, initialValue: false });
        if (isCancel(enable) || !enable) {
          continue;
        }
        await enableGroup(group);
      }
      await editGroup(group);
      continue;
    }

    const field = editable.find((f) => f.key === choice)!;
    const newValue = await promptField(field, values[field.key], true);
    if (newValue === FIELD_CANCELLED) {
      continue;
    }
    if (newValue !== undefined) {
      values[field.key] = newValue;
    } else {
      delete values[field.key];
    }
  }

  return splitValuesByCategory(fields, values);
}

/** A component's env values as currently present on the host. */
export type ExistingEnvState = {
  existingConfig: Record<string, string>;
  existingSecrets: Record<string, string>;
}

export async function readExistingEnvState(component: Component, host: Host): Promise<ExistingEnvState> {
  const { secretFields } = categorizeFields(componentFields(component));
  const secretKeys = secretFields.map((f) => f.key);

  const [envContent, secretsResult] = await Promise.all([
    host.readFile(`${ENV_DIR}/${component}.env`),
    secretKeys.length > 0
      ? readSecrets(host, SECRETS_DIR, secretKeys, "Read existing secrets")
      : Promise.resolve({ secrets: {} as Record<string, string>, permissionDenied: false }),
  ]);

  return {
    existingConfig: envContent ? parseEnvString(envContent) : {},
    existingSecrets: secretsResult.secrets,
  };
}

export type SecretFilePlan = {
  remove: string[];
  keptForOtherComponents: string[];
}

export async function secretKeysOfOtherComponents(component: Component, host: Host): Promise<Set<string>> {
  const manifest = await readManifest(host);
  const others = COMPONENTS.filter((c) => c !== component && manifest.components[c]);
  return new Set(
    others.flatMap((c) => categorizeFields(componentFields(c)).secretFields.map((f) => f.key)),
  );
}

export async function planSecretFileRemoval(
  component: Component,
  changes: EnvChange[],
  host: Host,
): Promise<SecretFilePlan> {
  const unset = changes.filter((c) => c.kind === "removed" && c.isSecret).map((c) => c.key);
  if (unset.length === 0) {
    return { remove: [], keptForOtherComponents: [] };
  }
  const heldElsewhere = await secretKeysOfOtherComponents(component, host);
  return {
    remove: unset.filter((key) => !heldElsewhere.has(key)),
    keptForOtherComponents: unset.filter((key) => heldElsewhere.has(key)),
  };
}

export type CollectedEnv = {
  changes: EnvChange[];
} & EnvBundle

/**
 * Planning-phase env collection: load current values from the host, prompt
 * for whatever is missing (or let the user edit), and report what applying
 * the result would change. Writes nothing. Returns null on cancel.
 */
export async function collectEnv(
  component: Component,
  host: Host,
  autoDefaults: Record<string, string>,
  skipKeys?: Set<string>,
): Promise<CollectedEnv | null> {
  const fields = componentFields(component);
  const { existingConfig, existingSecrets } = await readExistingEnvState(component, host);

  // Only the component's own env file marks it as previously configured.
  // The secrets dir is shared infrastructure: on a fresh install the redis
  // step already stored REDIS_URL there before any component exists, and
  // that must not make the first component look like a leftover install.
  const hasExistingConfig = Object.keys(existingConfig).length > 0;
  const existing = { ...autoDefaults, ...existingConfig, ...existingSecrets };

  const missingRequired = missingRequiredFields(fields, existing);

  const withChanges = (result: EnvBundle): CollectedEnv => ({
    ...result,
    changes: diffEnv(component, { config: existingConfig, secrets: existingSecrets }, result),
  });
  const useExisting = () => withChanges(splitValuesByCategory(fields, existing));

  const isInstalled = !!(await readManifest(host)).components[component];

  if (isInstalled && hasExistingConfig) {
    if (missingRequired.length === 0) {
      const action = await promptOrExit(select({
        message: "All configuration variables are already set.",
        options: [
          { value: "skip", label: "Keep current configuration" },
          { value: "edit", label: "Edit configuration" },
        ],
      }));
      if (action === "skip") return useExisting();
      const result = await menuEditEnv(fields, existing);
      return result ? withChanges(result) : useExisting();
    } else {
      log.info(
        `${missingRequired.length} new variable(s) need to be set. Edit any other values too if you like.`,
      );
      const result = await menuEditEnv(fields, existing);
      if (result === null) cancelAndExit();
      return withChanges(result);
    }
  } else if (hasExistingConfig && missingRequired.length === 0) {
    // Not in manifest but has existing config, preserve original behavior
    const reconfigure = await promptOrExit(confirm({
      message: "Existing configuration found. Reconfigure?",
      initialValue: false,
    }));
    if (!reconfigure) return useExisting();
  }

  return withChanges(await promptForEnv(component, fields, existing, skipKeys));
}
