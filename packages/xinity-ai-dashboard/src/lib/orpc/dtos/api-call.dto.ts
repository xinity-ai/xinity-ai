/**
 * DTO schemas for API call records and responses.
 */
import { z } from "zod";
import { CommonDto } from "./common.dto";

/** Describes a single message in an API call transcript. */
const CallMessageDto = z.object({
  content: z.string(),
  role: z.enum(["user", "assistent", "system"]),
});

/** Describes an API call record. */
export const ApiCallDto = CommonDto.extend({
  apiKeySpecifier: z.string(),
  model: z.string(),
  duration: z.number(),
  inputMessages: CallMessageDto.array(),
  outputMessage: CallMessageDto,
});

/** Describes a highlighted span within a response. */
export const HighlightDto = z.object({
  start: z.number(),
  end: z.number(),
  type: z.boolean(),
});
/** Describes a user response or annotation for a call. */
export const ApiCallResponseDto = CommonDto.extend({
  userId: z.string(),
  apiCallId: z.string().uuid(),
  blanketResponse: z.boolean().optional(),
  outputEdit: z.string().optional(),
  highlights: HighlightDto.array(),
});
