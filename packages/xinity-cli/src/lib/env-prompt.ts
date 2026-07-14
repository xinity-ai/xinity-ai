import { z } from "zod";
import { select, confirm, text, password, log, isCancel } from "./clack.ts";
import { bold, cyan, dim, yellow, green } from "picocolors";
import { promptOrExit, cancelAndExit } from "./output.ts";
import { parseEnvString } from "./env-file.ts";
import { type Component, ENV_SCHEMAS, ENV_DIR, SECRETS_DIR } from "./component-meta.ts";
import { readSecrets, type Host } from "./host.ts";
import { readManifest } from "./manifest.ts";

export interface EnvField {
  key: string;
  description?: string;
  hasDefault: boolean;
  defaultValue?: unknown;
  isOptional: boolean;
  isSecret: boolean;
  isExpert: boolean;
  isPublic: boolean;
  enumValues?: string[];
  isNumber: boolean;
  isBoolean: boolean;
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

    fields.push({
      key,
      description: prop.description,
      hasDefault: "default" in prop,
      defaultValue: prop.default,
      isOptional: !requiredKeys.has(key),
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

/** The single definition of "the config is invalid without this field". */
export function isRequiredUnset(field: EnvField, values: Record<string, string | undefined>): boolean {
  return !field.isOptional && !field.hasDefault && !values[field.key];
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

export interface EnvBundle {
  config: Record<string, string>;
  secrets: Record<string, string>;
}

export function flattenBundle(bundle: EnvBundle): Record<string, string> {
  return { ...bundle.config, ...bundle.secrets };
}

export interface EnvChange {
  key: string;
  kind: "added" | "changed" | "removed";
  isSecret: boolean;
  before?: string;
  after?: string;
}

/** What applying `after` would change relative to the values currently on the host. */
export function diffEnv(before: EnvBundle, after: EnvBundle): EnvChange[] {
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
  compare(before.config, after.config, false);
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
 * Fields marked with `.meta(expert())` in the schema are silently set from
 * `existingValues` (which includes auto-defaults) and only shown if the user
 * opts into advanced settings at the end.
 *
 * Returns split { config, secrets } records ready for writing.
 */
export async function promptForEnv(
  component: string,
  schema: z.ZodObject<any>,
  existingValues?: Record<string, string>,
  skipKeys?: Set<string>,
): Promise<{ config: Record<string, string>; secrets: Record<string, string> }> {
  const fields = analyzeEnvSchema(schema);
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

  if (expertFields.length > 0) {
    const showAdvanced = await promptOrExit(confirm({
      message: "Configure advanced settings?",
      initialValue: false,
    }));

    if (showAdvanced) {
      await promptFieldsUnderHeading(expertFields, "Advanced Settings", existingValues, config, secrets);
    }
  }

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

/**
 * Prompt for a single field value. Returns undefined if skipped. When
 * `cancelable`, Escape returns FIELD_CANCELLED instead of exiting the CLI
 * (menu editors treat it as backing out to the menu).
 */
async function promptField(
  field: EnvField,
  existingValue?: string,
  cancelable = false,
): Promise<string | undefined | typeof FIELD_CANCELLED> {
  const resolve = async <T>(prompt: Promise<T | symbol>): Promise<T | typeof FIELD_CANCELLED> => {
    const value = await prompt;
    if (isCancel(value)) {
      if (cancelable) return FIELD_CANCELLED;
      cancelAndExit();
    }
    return value as T;
  };

  const hint = field.description ? dim(` (${field.description})`) : "";
  const optTag = field.isOptional ? dim(" [optional]") : "";
  const existing = existingValue ?? (field.hasDefault ? String(field.defaultValue) : undefined);

  // Secret → masked password input
  if (field.isSecret) {
    const keepHint = existing ? dim(" [Enter to keep current]") : "";
    const value = await resolve(password({
      message: `${field.key}${hint}${optTag}${keepHint}`,
      validate: (val) => {
        if (!val && !existing && !field.isOptional && !field.hasDefault) return "This field is required";
        return undefined;
      },
    }));
    if (value === FIELD_CANCELLED) return value;
    return value || existing || undefined;
  }

  // Enum → select
  if (field.enumValues) {
    const options = field.enumValues.map((v) => ({ value: v, label: v }));
    if (field.isOptional) {
      options.unshift({ value: "__skip__", label: dim("skip") });
    }
    const value = await resolve(select({
      message: `${field.key}${hint}${optTag}`,
      options,
      initialValue: existing,
    }));
    if (value === FIELD_CANCELLED) return value;
    return value === "__skip__" ? undefined : value;
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
    message: `${field.key}${hint}${optTag}`,
    placeholder: existing ?? undefined,
    defaultValue: existing ?? undefined,
    validate: (val) => {
      if (!val && !existing && !field.isOptional && !field.hasDefault) return "This field is required";
      if (val && field.isNumber && Number.isNaN(Number(val))) return "Must be a number";
      return undefined;
    },
  }));
  if (value === FIELD_CANCELLED) return value;
  return value || undefined;
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

export interface MenuEditOptions {
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
 * are hidden behind an "advanced settings" toggle unless they already
 * carry a value or need attention.
 */
export async function menuEditEnv(
  schema: z.ZodObject<any>,
  existing: Record<string, string>,
  opts?: MenuEditOptions,
): Promise<{ config: Record<string, string>; secrets: Record<string, string> } | null> {
  const fields = analyzeEnvSchema(schema);
  const attentionKeys = opts?.attentionKeys ?? new Set<string>();
  const hiddenKeys = opts?.hiddenKeys ?? new Set<string>();
  const editable = fields.filter((f) => !hiddenKeys.has(f.key));
  const values: Record<string, string | undefined> = { ...existing };
  let showExpert = false;

  const isUnset = (f: EnvField) => values[f.key] === undefined || values[f.key] === "";
  const requiredUnset = (f: EnvField) => isRequiredUnset(f, values);
  const isVisible = (f: EnvField) =>
    !f.isExpert || showExpert || !isUnset(f) || requiredUnset(f) || attentionKeys.has(f.key);

  while (true) {
    const hiddenCount = editable.filter((f) => !isVisible(f)).length;

    const options = editable.filter(isVisible).map((field) => {
      const marker = requiredUnset(field)
        ? yellow("● required ")
        : attentionKeys.has(field.key) ? cyan("● review ") : "";
      const key = field.isExpert ? dim(field.key) : field.key;
      return {
        value: field.key,
        label: `${marker}${key}  ${displayValue(field, values[field.key])}`,
        hint: field.description,
      };
    });
    if (hiddenCount > 0) {
      options.push({ value: "__expert__", label: dim(`Show advanced settings (${hiddenCount} more)…`), hint: undefined });
    } else if (showExpert && editable.some((f) => f.isExpert)) {
      options.push({ value: "__expert__", label: dim("Hide advanced settings"), hint: undefined });
    }
    options.push({ value: "__save__", label: green("Save & exit"), hint: undefined });

    const choice = await select({
      message: opts?.message ?? "Select a value to update",
      options,
    });

    if (isCancel(choice)) return null;

    if (choice === "__expert__") {
      showExpert = !showExpert;
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
export interface ExistingEnvState {
  existingConfig: Record<string, string>;
  existingSecrets: Record<string, string>;
}

export async function readExistingEnvState(component: Component, host: Host): Promise<ExistingEnvState> {
  const { secretFields } = categorizeFields(analyzeEnvSchema(ENV_SCHEMAS[component]));
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

export interface CollectedEnv extends EnvBundle {
  changes: EnvChange[];
}

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
  const schema = ENV_SCHEMAS[component];
  const fields = analyzeEnvSchema(schema);
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
    changes: diffEnv({ config: existingConfig, secrets: existingSecrets }, result),
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
      const result = await menuEditEnv(schema, existing);
      return result ? withChanges(result) : useExisting();
    } else {
      log.info(
        `${missingRequired.length} new variable(s) need to be set. Edit any other values too if you like.`,
      );
      const result = await menuEditEnv(schema, existing);
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

  return withChanges(await promptForEnv(component, schema, existing, skipKeys));
}
