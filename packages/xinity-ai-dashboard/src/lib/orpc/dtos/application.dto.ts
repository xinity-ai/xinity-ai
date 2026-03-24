/**
 * DTO schema for Application responses and input validation.
 */
import { z } from "zod";
import { CommonDto } from "./common.dto";

export type ApplicationDto = z.infer<typeof ApplicationDto>;
export const ApplicationDto = CommonDto.extend({
  name: z.string().min(1).max(255).describe("Application name"),
  description: z.string().max(1000).nullable().describe("Application description"),
  organizationId: z.string().describe("Organization this application belongs to"),
});
