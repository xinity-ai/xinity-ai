import { z } from "zod";
import { readLeafMeta } from "./leaf-types";
import { isRequiredLeaf, type ConfigEntry } from "./group";
import { groupAt, type AnyConfig } from "./build";

export type ProjectedGroup = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** Env keys whose presence activates the group. Empty when the group is always present. */
  readonly activation: readonly string[];
};

function projectedMeta(entry: ConfigEntry, group: ProjectedGroup | undefined) {
  const meta = readLeafMeta(entry.schema);
  return {
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.isSecret ? { secret: true } : {}),
    ...(entry.isExpert ? { expert: true } : {}),
    ...(meta.public === true ? { public: true } : {}),
    ...(group ? { group } : {}),
  };
}

/**
 * The flat env-keyed schema `parseEnv` consumes, so a service adopts a grouped declaration without
 * touching a call site.
 *
 * Parsed flatly there is no activation gate, so a field an optional group would have guarded has to
 * tolerate absence on its own. Only fields that would otherwise be required are wrapped: wrapping a
 * defaulted one would shadow its default, since ZodOptional short-circuits on undefined.
 */
export function toFlatSchema(config: AnyConfig): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};

  for (const entry of config.entries) {
    const mounted = entry.path.length > 1 ? groupAt(config, entry.path[0]!) : undefined;
    const group: ProjectedGroup | undefined = mounted && {
      id: mounted.group.id,
      title: mounted.group.title,
      description: mounted.group.description,
      activation: mounted.activation,
    };

    const guarded = mounted && mounted.activation.length > 0 && isRequiredLeaf(entry);
    const projected = guarded ? entry.schema.optional() : entry.schema;
    shape[entry.envKey] = projected.meta(projectedMeta(entry, group));
  }

  return z.object(shape);
}
