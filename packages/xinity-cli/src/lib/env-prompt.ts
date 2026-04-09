import { z } from "zod";
import * as p from "./clack.ts";
import pc from "picocolors";
import { cancelAndExit } from "./output.ts";
import { parseEnvString } from "./env-file.ts";
import { type Component, ENV_SCHEMAS, ENV_DIR, SECRETS_DIR, getAutoDefaults } from "./component-meta.ts";
import { writeEnvConfig, restartService } from "./service.ts";
import { createLocalHost, type Host } from "./host.ts";

export interface EnvField {
  key: string;
  description?: string;
  hasDefault: boolean;
  defaultValue?: unknown;
  isOptional: boolean;
  isSecret: boolean;
  isExpert: boolean;
  isEnum: boolean;
  enumValues?: string[];
  isNumber: boolean;
  isBoolean: boolean;
}

function readFieldMeta(field: z.ZodType): { secret: boolean; expert: boolean } {
  const meta = z.globalRegistry.get(field);
  return {
    secret: meta?.secret === true,
    expert: meta?.expert === true,
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

/**
 * Menu-based interactive configuration for a component's env vars.
 *
 * Shows all fields in a select menu with current values. The user picks
 * a field to edit, updates it, then returns to the menu. "Save & exit"
 * persists the config to disk.
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

  // Load existing values from the host
  const envPath = `${ENV_DIR}/${component}.env`;
  const envContent = await h.readFile(envPath);
  const existingConfig = envContent ? parseEnvString(envContent) : {};
  const existingSecrets: Record<string, string> = {};
  let secretsLocked = false;
  if (secretKeys.length > 0) {
    for (const key of secretKeys) {
      const content = await h.readFile(`${SECRETS_DIR}/${key}`);
      if (content !== null) existingSecrets[key] = content.trim();
    }
    const missing = secretKeys.filter((k) => !(k in existingSecrets));
    if (missing.length > 0) {
      const script = missing
        .map((k) => `[ -f '${SECRETS_DIR}/${k}' ] && printf '%s\\0%s\\0' '${k}' "$(cat '${SECRETS_DIR}/${k}')"`)
        .join("; ");
      const result = await h.withElevation(script, "Read existing secrets", { sensitive: true });
      if (result.success) {
        const parts = result.output.split("\0").filter(Boolean);
        for (let i = 0; i < parts.length - 1; i += 2) {
          existingSecrets[parts[i]!] = parts[i + 1]!.trim();
        }
      } else if (result.skipped) {
        secretsLocked = true;
      }
    }
  }
  const autoDefaults = getAutoDefaults(component);
  const values: Record<string, string | undefined> = { ...autoDefaults, ...existingConfig, ...existingSecrets };

  while (true) {
    const options = fields.map((field) => ({
      value: field.key,
      label: `${field.key}  ${displayValue(field, values[field.key], secretsLocked && field.isSecret)}`,
      hint: field.description,
    }));
    options.push({ value: "__save__", label: pc.green("Save & exit"), hint: undefined });

    const choice = await p.select({
      message: "Select a value to update",
      options,
    });

    if (p.isCancel(choice)) {
      p.cancel("Cancelled, no changes saved.");
      return;
    }

    if (choice === "__save__") break;

    const field = fields.find((f) => f.key === choice)!;
    const newValue = await promptField(field, values[field.key]);
    if (newValue !== undefined) {
      values[field.key] = newValue;
    } else {
      // User cleared the value (empty input on optional field)
      delete values[field.key];
    }
  }

  // Split into config and secrets for writing
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of fields) {
    const val = values[field.key];
    if (val === undefined) continue;
    if (field.isSecret) secrets[field.key] = val;
    else config[field.key] = val;
  }

  const wrote = await writeEnvConfig(component, config, secrets, h);
  if (wrote) {
    await restartService(component, h);
  }
  p.outro("Done");
}

