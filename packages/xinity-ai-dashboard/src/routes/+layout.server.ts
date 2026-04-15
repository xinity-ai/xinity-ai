import { z } from "zod";
import { dashboardEnvSchema } from "$lib/server/env-schema";
import { serverEnv } from "$lib/server/serverenv";

export const load = () => {
  const clientEnv: Record<string, string> = {};
  for (const [key, field] of Object.entries(dashboardEnvSchema.shape)) {
    const meta = z.globalRegistry.get(field as z.ZodType);
    if (meta?.public === true) {
      const val = serverEnv[key as keyof typeof serverEnv];
      if (val != null) clientEnv[key] = String(val);
    }
  }
  return { clientEnv };
};
