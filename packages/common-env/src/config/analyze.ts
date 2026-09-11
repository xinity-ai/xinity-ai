import { z } from "zod";
import type { AnyConfig } from "./build";

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
  isRequired: boolean;
  isSecret: boolean;
  isExpert: boolean;
  isPublic: boolean;
  enumValues?: string[];
  isBoolean: boolean;
  validate: (raw: string) => string | undefined;
  /** Only set for components on a grouped declaration. */
  group?: EnvFieldGroup;
}

function schemaValidator(schema: z.ZodType): (raw: string) => string | undefined {
  return (raw) => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? undefined : parsed.error.issues[0]?.message;
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

const configFieldCache = new WeakMap<AnyConfig, EnvField[]>();

/** Flattens a declaration into one row per env key, for surfaces that present keys rather than values. */
export function analyzeConfig(config: AnyConfig): EnvField[] {
  const cached = configFieldCache.get(config);
  if (cached) {
    return cached;
  }

  const fields = config.entries.map((entry): EnvField => {
    const prop = z.toJSONSchema(entry.schema, { io: "output" }) as JsonSchemaProp;
    const withoutValue = entry.schema.safeParse(undefined);
    const resolvedType = resolveJsonSchemaType(prop);
    const mounted = config.groups.find((candidate) => candidate.group.id === entry.groupId);

    return {
      key: entry.envKey,
      description: entry.description,
      hasDefault: withoutValue.success && withoutValue.data !== undefined,
      defaultValue: withoutValue.success ? withoutValue.data : undefined,
      isRequired: !withoutValue.success,
      isSecret: entry.isSecret,
      isExpert: entry.isExpert,
      isPublic: entry.isPublic,
      enumValues: extractEnumValues(prop),
      isBoolean: resolvedType === "boolean",
      validate: schemaValidator(entry.schema),
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
