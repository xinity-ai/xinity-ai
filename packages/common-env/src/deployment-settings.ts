import { z } from "zod";

// The first goal is the default.
export const OPTIMIZATION_GOALS = ["space", "speed"] as const;
export type OptimizationGoal = (typeof OPTIMIZATION_GOALS)[number];

export const deploymentSettingsSchema = z.object({
  version: z.literal(1),
  maxAudioInputDurationS: z.number().optional(),
  maxAudioInputFileSizeMB: z.number().optional(),
  optimizeFor: z.enum(OPTIMIZATION_GOALS).optional(),
});

export type DeploymentSettingsV1 = z.infer<typeof deploymentSettingsSchema>;

export type DeploymentSettings = DeploymentSettingsV1;

const SETTING_DEFAULTS: Partial<DeploymentSettingsV1> = {
  optimizeFor: OPTIMIZATION_GOALS[0],
};

export function isOptimizationGoal(value: unknown): value is OptimizationGoal {
  return OPTIMIZATION_GOALS.includes(value as OptimizationGoal);
}

// A setting stated at its default means the same as leaving it unset.
export function normalizeSettings(settings: DeploymentSettings): Record<string, number | string> {
  const entries = Object.entries(settings).filter(([key, value]) =>
    key !== "version" && value != null && value !== SETTING_DEFAULTS[key as keyof DeploymentSettingsV1]);
  return Object.fromEntries(entries);
}

export function settingsEqual(a: DeploymentSettings, b: DeploymentSettings): boolean {
  const na = normalizeSettings(a);
  const nb = normalizeSettings(b);
  const aKeys = Object.keys(na);
  if (aKeys.length !== Object.keys(nb).length) {
    return false;
  }
  return aKeys.every((key) => na[key] === nb[key]);
}

// Version-aware field accessors: each setting has a resolve function that
// returns undefined for unknown versions, so older services fall back to the
// engine default rather than misreading an incompatible shape.

function resolveV1Field<T>(
  settings: DeploymentSettings | null | undefined,
  fn: (s: DeploymentSettingsV1) => T,
): T | undefined {
  if (settings == null || (settings as { version: number }).version !== 1) {
    return undefined;
  }
  return fn(settings);
}

export function resolveMaxAudioInputDurationS(settings: DeploymentSettings | null | undefined): number | undefined {
  return resolveV1Field(settings, (s) => s.maxAudioInputDurationS);
}

export function resolveMaxAudioInputFileSizeMB(settings: DeploymentSettings | null | undefined): number | undefined {
  return resolveV1Field(settings, (s) => s.maxAudioInputFileSizeMB);
}

export function resolveOptimizeFor(settings: DeploymentSettings | null | undefined): OptimizationGoal {
  return resolveV1Field(settings, (s) => s.optimizeFor) ?? OPTIMIZATION_GOALS[0];
}
