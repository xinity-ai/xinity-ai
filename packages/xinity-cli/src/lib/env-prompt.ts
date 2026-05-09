import { z } from "zod";
import * as p from "./clack.ts";
import pc from "picocolors";
import { cancelAndExit } from "./output.ts";
import { parseEnvString } from "./env-file.ts";
import { type Component, ENV_SCHEMAS, ENV_DIR, SECRETS_DIR, getAutoDefaults } from "./component-meta.ts";
import { writeEnvConfig, restartService } from "./service.ts";
import { createLocalHost, readSecrets, type Host } from "./host.ts";

export interface EnvField {
  key: string;
  description?: string;
  hasDefault: boolean;
  defaultValue?: unknown;
  isOptional: boolean;
  isSecret: boolean;
  isExpert: boolean;
  isPublic: boolean;
  isEnum: boolean;
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

/** Analyze a Zod env schema into structured field metadata. */
export function analyzeEnvSchema(
  schema: z.ZodObject<any>,
): EnvField[] {
  const jsonSchema = z.toJSONSchema(schema) as {
    properties: Record<string, any>;
    required?: string[];
  };
  const requiredKeys = new Set(jsonSchema.required ?? []);

  const fields: EnvField[] = [];
  for (const [key, zodField] of Object.entries(schema.shape)) {
    const prop = jsonSchema.properties[key] ?? {};
    const meta = readFieldMeta(zodField as z.ZodType);

    // Detect enum
    const enumValues: string[] | undefined = prop.enum ?? prop.anyOf?.find((a: any) => a.enum)?.enum;

    // Detect type (handle anyOf for nullable)
    let resolvedType = prop.type;
    if (prop.anyOf) {
      const nonNull = prop.anyOf.find((a: any) => a.type !== "null");
      resolvedType = nonNull?.type ?? "string";
    }

    fields.push({
      key,
      description: prop.description,
      hasDefault: "default" in prop,
      defaultValue: prop.default,
      isOptional: !requiredKeys.has(key),
      isSecret: meta.secret,
      isExpert: meta.expert,
      isPublic: meta.public,
      isEnum: !!enumValues,
      enumValues,
      isNumber: resolvedType === "number" || resolvedType === "integer",
      isBoolean: resolvedType === "boolean",
    });
  }

  return fields;
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

  // Pre-fill expert fields from existing values (includes auto-defaults)
  for (const field of expertFields) {
    const val = existingValues?.[field.key];
    if (val !== undefined) {
      if (field.isSecret) secrets[field.key] = val;
      else config[field.key] = val;
    }
  }

  // Pre-fill skipped fields from existing values (already configured)
  for (const field of skippedFields) {
    const val = existingValues?.[field.key];
    if (val !== undefined) {
      if (field.isSecret) secrets[field.key] = val;
      else config[field.key] = val;
    }
  }

  // Prompt visible config fields
  if (visibleConfig.length > 0) {
    p.log.step(pc.bold("Configuration"));
    for (const field of visibleConfig) {
      const value = await promptField(field, existingValues?.[field.key]);
      if (value !== undefined) config[field.key] = value;
    }
  }

  // Prompt visible secret fields
  if (visibleSecrets.length > 0) {
    p.log.step(pc.bold("Secrets"));
    for (const field of visibleSecrets) {
      const value = await promptField(field, existingValues?.[field.key]);
      if (value !== undefined) secrets[field.key] = value;
    }
  }

  // Offer advanced settings if there are expert fields
  if (expertFields.length > 0) {
    const showAdvanced = await p.confirm({
      message: "Configure advanced settings?",
      initialValue: false,
    });
    if (p.isCancel(showAdvanced)) cancelAndExit();

    if (showAdvanced) {
      p.log.step(pc.bold("Advanced Settings"));
      for (const field of expertFields) {
        const value = await promptField(field, existingValues?.[field.key]);
        if (value !== undefined) {
          if (field.isSecret) secrets[field.key] = value;
          else config[field.key] = value;
        }
      }
    }
  }

  return { config, secrets };
}

/** Prompt for a single field value. Returns undefined if skipped. */
async function promptField(
  field: EnvField,
  existingValue?: string,
): Promise<string | undefined> {
  const hint = field.description ? pc.dim(` (${field.description})`) : "";
  const optTag = field.isOptional ? pc.dim(" [optional]") : "";
  const existing = existingValue ?? (field.hasDefault ? String(field.defaultValue) : undefined);

  // Secret → masked password input
  if (field.isSecret) {
    const keepHint = existing ? pc.dim(" [Enter to keep current]") : "";
    const value = await p.password({
      message: `${field.key}${hint}${optTag}${keepHint}`,
      validate: (val) => {
        if (!val && !existing && !field.isOptional && !field.hasDefault) return "This field is required";
        return undefined;
      },
    });
    if (p.isCancel(value)) cancelAndExit();
    return value || existing || undefined;
  }

  // Enum → select
  if (field.isEnum && field.enumValues) {
    const options = [
      ...field.enumValues.map((v) => ({ value: v, label: v })),
    ];
    if (field.isOptional) {
      options.unshift({ value: "__skip__", label: pc.dim("skip") });
    }
    const value = await p.select({
      message: `${field.key}${hint}${optTag}`,
      options,
      initialValue: existing,
    });
    if (p.isCancel(value)) cancelAndExit();
    return value === "__skip__" ? undefined : value;
  }

  // Boolean → confirm
  if (field.isBoolean) {
    const value = await p.confirm({
      message: `${field.key}${hint}`,
      initialValue: existing === "true" || existing === "1" || (field.hasDefault && field.defaultValue === true),
    });
    if (p.isCancel(value)) cancelAndExit();
    return String(value);
  }

  // Number or string → text input
  const value = await p.text({
    message: `${field.key}${hint}${optTag}`,
    placeholder: existing ?? undefined,
    defaultValue: existing ?? undefined,
    validate: (val) => {
      if (!val && !existing && !field.isOptional && !field.hasDefault) return "This field is required";
      if (val && field.isNumber && Number.isNaN(Number(val))) return "Must be a number";
      return undefined;
    },
  });
  if (p.isCancel(value)) cancelAndExit();
  return value || undefined;
}

/** Format a field's current value for display in the menu. */
function displayValue(field: EnvField, value: string | undefined, locked = false): string {
  if (value !== undefined && value !== "") {
    if (field.isSecret) return pc.dim("••••••");
    return pc.cyan(value);
  }
  if (locked && field.isSecret) return pc.dim("(locked)");
  if (field.hasDefault) return pc.dim(`(default: ${field.defaultValue})`);
  if (field.isOptional) return pc.dim("(not set)");
  return pc.yellow("(not set)");
}

export interface MenuEditOptions {
  /** Keys flagged as "new" — highlighted in label and required to be set before save. */
  newKeys?: Set<string>;
  /** Secrets we couldn't read because elevation was skipped — shown as (locked). */
  secretsLocked?: boolean;
  /** Message displayed above the menu. */
  message?: string;
}

/**
 * Menu-based env editor. Returns the merged { config, secrets } without
 * persisting anything. Returns null if the user cancels.
 *
 * Used by both `xinity configure` (where the caller writes to disk and
 * restarts the service) and the `xinity up` update flow (where the caller
 * passes the result through the installer's existing write path).
 */
export async function menuEditEnv(
  schema: z.ZodObject<any>,
  existing: Record<string, string>,
  opts?: MenuEditOptions,
): Promise<{ config: Record<string, string>; secrets: Record<string, string> } | null> {
  const fields = analyzeEnvSchema(schema);
  const newKeys = opts?.newKeys ?? new Set<string>();
  const secretsLocked = opts?.secretsLocked ?? false;
  const values: Record<string, string | undefined> = { ...existing };

  const newMarker = pc.yellow("● new ");

  while (true) {
    const options = fields.map((field) => {
      const marker = newKeys.has(field.key) ? newMarker : "";
      return {
        value: field.key,
        label: `${marker}${field.key}  ${displayValue(field, values[field.key], secretsLocked && field.isSecret)}`,
        hint: field.description,
      };
    });
    options.push({ value: "__save__", label: pc.green("Save & exit"), hint: undefined });

    const choice = await p.select({
      message: opts?.message ?? "Select a value to update",
      options,
    });

    if (p.isCancel(choice)) return null;

    if (choice === "__save__") {
      const unsetRequiredNew = fields.filter(
        (f) =>
          newKeys.has(f.key) &&
          !f.isOptional &&
          !f.hasDefault &&
          (values[f.key] === undefined || values[f.key] === ""),
      );
      if (unsetRequiredNew.length > 0) {
        p.log.warn(
          `These new variables are required and not set: ${unsetRequiredNew.map((f) => f.key).join(", ")}`,
        );
        continue;
      }
      break;
    }

    const field = fields.find((f) => f.key === choice)!;
    const newValue = await promptField(field, values[field.key]);
    if (newValue !== undefined) {
      values[field.key] = newValue;
    } else {
      delete values[field.key];
    }
  }

  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of fields) {
    const val = values[field.key];
    if (val === undefined) continue;
    if (field.isSecret) secrets[field.key] = val;
    else config[field.key] = val;
  }
  return { config, secrets };
}

/**
 * Menu-based interactive configuration for a component's env vars.
 *
 * Loads current values from disk, opens the menu editor, and on save
 * persists the result and restarts the service.
 */
export async function menuConfigureEnv(
  component: Component,
  host?: Host,
): Promise<void> {
  const h = host ?? createLocalHost();
  const schema = ENV_SCHEMAS[component];
  const fields = analyzeEnvSchema(schema);
  const { secretFields } = categorizeFields(fields);
  const secretKeys = secretFields.map((f) => f.key);

  p.intro(`xinity configure ${pc.cyan(component)}`);

  const envPath = `${ENV_DIR}/${component}.env`;
  const envContent = await h.readFile(envPath);
  const existingConfig = envContent ? parseEnvString(envContent) : {};
  let secretsLocked = false;
  let existingSecrets: Record<string, string> = {};
  if (secretKeys.length > 0) {
    const sr = await readSecrets(h, SECRETS_DIR, secretKeys, "Read existing secrets");
    existingSecrets = sr.secrets;
    secretsLocked = sr.skipped;
  }
  const autoDefaults = getAutoDefaults(component);
  const existing: Record<string, string> = { ...autoDefaults, ...existingConfig, ...existingSecrets };

  const result = await menuEditEnv(schema, existing, { secretsLocked });
  if (result === null) {
    p.cancel("Cancelled, no changes saved.");
    return;
  }

  const wrote = await writeEnvConfig(component, result.config, result.secrets, h);
  if (wrote) {
    await restartService(component, h);
  }
  p.outro("Done");
}

