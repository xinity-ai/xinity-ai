import { z } from "zod";

/** How a rollout's progress moves. Stored as is, so every type carries its own version. */
export const rolloutAdvanceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("manual"),
    version: z.literal(1),
  }),
  z.object({
    type: z.literal("time"),
    version: z.literal(1),
    startProgress: z.number().int().min(0).max(100).describe("Progress when the rollout started moving"),
    from: z.iso.datetime().describe("When progress started moving towards 100"),
    until: z.iso.datetime().describe("When progress reaches 100"),
  }),
]);

export type RolloutAdvance = z.infer<typeof rolloutAdvanceSchema>;
