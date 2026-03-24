/**
 * Base DTOs shared across ORPC procedures.
 */
import { z } from "zod";

export const CommonDto = z.object({
  id: z.uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const commonInputFilter = { createdAt: true, updatedAt: true } as const;
