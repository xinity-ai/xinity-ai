import { z } from "zod";

import { env } from "$env/dynamic/public";

export const clientEnv = z
  .object({
    PUBLIC_LLM_API_URL: z.url().default("https://api.xinity.ai/v1")
  })
  .parse(env);
