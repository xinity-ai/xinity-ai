import { z } from "zod";

export const RunnerTokenDto = z.object({
  id: z.uuid(),
  name: z.string().trim(),
  secretPreview: z.string(),
  lastSeenAt: z.date().nullable(),
  createdAt: z.date(),
});

export const CreatedRunnerTokenDto = RunnerTokenDto.extend({
  /** Plaintext secret. Returned once at creation; never stored or returned again. */
  secret: z.string(),
});
