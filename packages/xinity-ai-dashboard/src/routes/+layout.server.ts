import { readLeafMeta } from "common-env";
import { dashboardConfig } from "$lib/server/config-schema";
import { config } from "$lib/server/config";

export const load = () => {
  const clientEnv: Record<string, string> = {};
  for (const entry of dashboardConfig.entries) {
    if (readLeafMeta(entry.schema).public !== true) {
      continue;
    }
    let value: unknown = config;
    for (const key of entry.path) {
      value = (value as Record<string, unknown> | undefined)?.[key];
    }
    if (value != null) {
      clientEnv[entry.envKey] = String(value);
    }
  }
  return { clientEnv };
};
