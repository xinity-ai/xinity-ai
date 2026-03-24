/**
 * DTO schema for API key responses and input validation.
 */
import { z } from "zod";
import { CommonDto } from "./common.dto";

export type ApiKeyDto = z.infer<typeof ApiKeyDto>;
export const ApiKeyDto = CommonDto.extend({
  specifier: z.string().describe("Identifying start of the api key. This fulfills the role of an id, while also being the initial bits of the api key"),
  name: z.string().describe("Given name of the api key, for ease of recognition"),
  enabled: z.boolean().describe("Flag to en- or disable the api key temporarily"),
  applicationId: z.uuid().nullable().describe("Default application for this API key (optional)"),
  collectData: z.boolean().describe("Whether this API key logs call data"),
  createdByUserId: z.string().nullable().describe("User who created this API key"),
  createdByUserName: z.string().nullable().describe("Name of the user who created this API key"),
});
