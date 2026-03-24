import { z } from "zod";
import * as p from "./clack.ts";
import pc from "picocolors";
import { cancelAndExit } from "./output.ts";

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  format?: string;
  anyOf?: { type: string }[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

interface JsonSchema {
  type: string;
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/** Resolve the effective type from a JSON Schema property (handles nullable via anyOf). */
function resolveType(prop: JsonSchemaProperty): {
  type: string;
  nullable: boolean;
  enumValues?: string[];
} {
  if (prop.anyOf) {
    const types = prop.anyOf.map((a) => a.type);
    const nullable = types.includes("null");
    const nonNull = prop.anyOf.find((a) => a.type !== "null");
    return {
      type: nonNull?.type ?? "string",
      nullable,
      enumValues: (nonNull as JsonSchemaProperty)?.enum,
    };
  }
  return {
    type: prop.type ?? "string",
    nullable: false,
    enumValues: prop.enum,
  };
}

function formatFieldName(key: string): string {
  // camelCase → spaced: "publicSpecifier" → "public specifier"
  return key.replace(/([A-Z])/g, " $1").toLowerCase();
}

/**
 * Prompt the user interactively for all fields in a Zod object schema.
 * Returns a plain object matching the schema's shape.
 */
export async function promptForSchema(
  schema: z.ZodType,
  options?: { skipOptional?: boolean },
): Promise<Record<string, unknown>> {
  const jsonSchema = z.toJSONSchema(schema) as JsonSchema;

  if (jsonSchema.type !== "object" || !jsonSchema.properties) {
    throw new Error("Schema must be a Zod object type for interactive prompting");
  }

  const result: Record<string, unknown> = {};
  const requiredFields = new Set(jsonSchema.required ?? []);

  for (const [key, prop] of Object.entries(jsonSchema.properties)) {
    const isRequired = requiredFields.has(key);
    const { type, nullable, enumValues } = resolveType(prop);
    const label = formatFieldName(key);
    const hint = prop.description ?? undefined;
    const defaultVal = prop.default;

    // Skip optional fields if requested
    if (!isRequired && options?.skipOptional) continue;

    const requiredTag = isRequired ? "" : pc.dim(" (optional, enter to skip)");

    // Enum → select
    if (enumValues) {
      const value = await p.select({
        message: `${label}${requiredTag}`,
        options: [
          ...((!isRequired || nullable)
            ? [{ value: "__skip__" as const, label: pc.dim("skip"), hint: "leave empty" }]
            : []),
          ...enumValues.map((v) => ({ value: v, label: v })),
        ],
      });
      if (p.isCancel(value)) {
        cancelAndExit();
      }
      if (value !== "__skip__") result[key] = value;
      continue;
    }

    // Boolean → confirm
    if (type === "boolean") {
      const value = await p.confirm({
        message: `${label}?${hint ? ` ${pc.dim(`(${hint})`)}` : ""}`,
        initialValue: typeof defaultVal === "boolean" ? defaultVal : false,
      });
      if (p.isCancel(value)) {
        cancelAndExit();
      }
      result[key] = value;
      continue;
    }

    // Number → text with validation
    if (type === "number" || type === "integer") {
      const value = await p.text({
        message: `${label}${requiredTag}`,
        placeholder: hint ?? (defaultVal !== undefined ? String(defaultVal) : undefined),
        defaultValue: defaultVal !== undefined ? String(defaultVal) : undefined,
        validate: (val) => {
          if (!val && !isRequired) return undefined;
          if (!val && isRequired) return "This field is required";
          if (Number.isNaN(Number(val))) return "Must be a number";
          return undefined;
        },
      });
      if (p.isCancel(value)) {
        cancelAndExit();
      }
      if (value) result[key] = Number(value);
      continue;
    }

    // Nested object → recurse (flat prompt with prefixed names)
    if (type === "object" && prop.properties) {
      p.log.step(pc.bold(label));
      const nested: Record<string, unknown> = {};
      const nestedRequired = new Set(prop.required ?? []);

      for (const [nKey, nProp] of Object.entries(prop.properties)) {
        const nResolved = resolveType(nProp);
        const nLabel = `  ${formatFieldName(nKey)}`;
        const nIsRequired = nestedRequired.has(nKey);

        if (nResolved.type === "boolean") {
          const val = await p.confirm({
            message: `${nLabel}?`,
            initialValue:
              typeof nProp.default === "boolean" ? nProp.default : false,
          });
          if (p.isCancel(val)) {
            cancelAndExit();
          }
          nested[nKey] = val;
        } else {
          const val = await p.text({
            message: `${nLabel}${nIsRequired ? "" : pc.dim(" (optional)")}`,
            placeholder: nProp.description,
          });
          if (p.isCancel(val)) {
            cancelAndExit();
          }
          if (val) nested[nKey] = val;
        }
      }
      if (Object.keys(nested).length > 0) result[key] = nested;
      continue;
    }

    // String (default) → text input
    const value = await p.text({
      message: `${label}${requiredTag}`,
      placeholder: hint,
      defaultValue: typeof defaultVal === "string" ? defaultVal : undefined,
      validate: (val) => {
        if (!val && isRequired) return "This field is required";
        return undefined;
      },
    });
    if (p.isCancel(value)) {
      cancelAndExit();
    }
    if (value) {
      result[key] = nullable && value === "null" ? null : value;
    }
  }

  return result;
}
