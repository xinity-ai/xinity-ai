import { z } from "zod";

export const deploymentSettingsSchema = z.object({
  version: z.literal(1),
  maxAudioInputDurationS: z.number().optional(),
  maxAudioInputFileSizeMB: z.number().optional(),
});

export type DeploymentSettingsV1 = z.infer<typeof deploymentSettingsSchema>;

export type DeploymentSettings = DeploymentSettingsV1;

export function normalizeSettings(settings: DeploymentSettings): Record<string, number> {
  const entries = Object.entries(settings)
    .filter(([key, value]) => key !== "version" && value != null);
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

export function mergeSettings(a: DeploymentSettings, b: DeploymentSettings): DeploymentSettings {
  const merged: DeploymentSettings = { version: 1 };
  const durations = [a.maxAudioInputDurationS, b.maxAudioInputDurationS]
    .filter((value): value is number => value != null);
  if (durations.length > 0) {
    merged.maxAudioInputDurationS = Math.max(...durations);
  }
  const fileSizes = [a.maxAudioInputFileSizeMB, b.maxAudioInputFileSizeMB]
    .filter((value): value is number => value != null);
  if (fileSizes.length > 0) {
    merged.maxAudioInputFileSizeMB = Math.max(...fileSizes);
  }
  return merged;
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
