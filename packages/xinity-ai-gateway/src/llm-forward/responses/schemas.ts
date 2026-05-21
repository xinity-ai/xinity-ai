import { z } from "zod";

const WebSearchTypeSchema = z.enum([
  "web_search", "web_search_preview", "web_search_preview_2025_03_11"])
  .transform(() => "web_search" as const);

const BuiltinToolSchema = z.looseObject({
  type: WebSearchTypeSchema,
});

const FunctionToolSchema = z.looseObject({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
});

const ToolDefinitionSchema = z.union([
  WebSearchTypeSchema,
  BuiltinToolSchema,
  FunctionToolSchema,
]);

const TextFormatSchema = z.object({
  format: z.object({
    type: z.enum(["text", "json", "json_object", "json_schema"]).default("text"),
    json_schema: z.object({
      name: z.string().optional(),
      schema: z.unknown().optional(),
    }).optional(),
  }).optional(),
}).optional();

const ReasoningSchema = z.object({
  effort: z.enum(["low", "medium", "high"]).nullable().optional(),
  summary: z.enum(["auto", "concise", "detailed"]).nullable().optional(),
}).optional();

const ToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.looseObject({ type: z.string() }),
]);

export const CreateResponseBodySchema = z.object({
  model: z.string(),
  input: z.unknown(),
  stream: z.boolean().optional().default(false),
  background: z.boolean().optional().default(false),
  store: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_output_tokens: z.number().nullable().optional(),
  max_tokens: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  seed: z.number().optional(),
  instructions: z.string().nullable().optional(),
  tools: z.array(ToolDefinitionSchema).optional().default([]),
  tool_choice: ToolChoiceSchema.optional().default("auto"),
  text: TextFormatSchema,
  include: z.array(z.string()).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  previous_response_id: z.string().nullable().optional(),
  truncation: z.string().nullable().optional().default("disabled"),
  user: z.string().nullable().optional(),
  reasoning: ReasoningSchema,
  parallel_tool_calls: z.boolean().optional().default(true),
  // Aliases
  messages: z.unknown().optional(),
  prompt: z.unknown().optional(),
});

export type CreateResponseBody = z.infer<typeof CreateResponseBodySchema>;

const AnnotationSchema = z.looseObject({
  type: z.enum(["url_citation", "file_citation", "file_path"]),
  url: z.string().optional(),
  title: z.string().optional(),
  start_index: z.number().optional(),
  end_index: z.number().optional(),
});

export const OutputTextContentPartSchema = z.object({
  type: z.literal("output_text"),
  text: z.string(),
  annotations: z.array(AnnotationSchema).default([]),
  logprobs: z.unknown().nullable().default(null),
});

export type OutputTextContentPart = z.infer<typeof OutputTextContentPartSchema>;

export const RefusalContentPartSchema = z.object({
  type: z.literal("refusal"),
  refusal: z.string(),
});

export type RefusalContentPart = z.infer<typeof RefusalContentPartSchema>;

export const ContentPartSchema = z.discriminatedUnion("type", [
  OutputTextContentPartSchema,
  RefusalContentPartSchema,
]);

export type ContentPart = z.infer<typeof ContentPartSchema>;

export const MessageOutputItemSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  status: z.enum(["in_progress", "completed", "incomplete"]),
  role: z.literal("assistant"),
  content: z.array(ContentPartSchema),
});

export type MessageOutputItem = z.infer<typeof MessageOutputItemSchema>;

export const WebSearchCallOutputItemSchema = z.object({
  id: z.string(),
  type: z.literal("web_search_call"),
  status: z.enum(["in_progress", "searching", "completed", "failed"]),
  results: z.array(z.unknown()).optional(),
  action: z.object({
    type: z.string().default("search"),
    query: z.string().optional(),
    sources: z.array(z.object({
      type: z.enum(["url_citation"]),
      url: z.string(),
      title: z.string(),
    })).optional(),
  }).optional(),
});

export type WebSearchCallOutputItem = z.infer<typeof WebSearchCallOutputItemSchema>;

export const FunctionCallOutputItemSchema = z.object({
  id: z.string(),
  type: z.literal("function_call"),
  status: z.enum(["in_progress", "completed", "failed"]),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

export type FunctionCallOutputItem = z.infer<typeof FunctionCallOutputItemSchema>;

export const OutputItemSchema = z.discriminatedUnion("type", [
  MessageOutputItemSchema,
  WebSearchCallOutputItemSchema,
  FunctionCallOutputItemSchema,
]);

export type OutputItem = z.infer<typeof OutputItemSchema>;

export const UsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
  input_tokens_details: z.object({
    cached_tokens: z.number().default(0),
  }),
  output_tokens_details: z.object({
    reasoning_tokens: z.number().default(0),
  }),
});

export type Usage = z.infer<typeof UsageSchema>;

export const ResponseObjectSchema = z.object({
  id: z.string(),
  object: z.literal("response"),
  created_at: z.number(),
  status: z.enum(["in_progress", "completed", "failed", "incomplete"]),
  completed_at: z.number().nullable(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).nullable(),
  incomplete_details: z.object({
    reason: z.string(),
  }).nullable(),
  instructions: z.string().nullable(),
  max_output_tokens: z.number().nullable(),
  model: z.string(),
  output: z.array(OutputItemSchema),
  parallel_tool_calls: z.boolean(),
  previous_response_id: z.string().nullable(),
  reasoning: z.object({
    effort: z.string().nullable(),
    summary: z.string().nullable(),
  }).nullable(),
  store: z.boolean(),
  temperature: z.number().nullable(),
  text: z.object({
    format: z.looseObject({ type: z.string() }),
  }).nullable(),
  tool_choice: ToolChoiceSchema,
  tools: z.array(ToolDefinitionSchema),
  top_p: z.number().nullable(),
  truncation: z.string().nullable(),
  usage: UsageSchema.nullable(),
  user: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export type ResponseObject = z.infer<typeof ResponseObjectSchema>;

function responseLifecycleEventSchema<T extends string>(type: T) {
  return z.object({
    type: z.literal(type),
    response: ResponseObjectSchema,
    sequence_number: z.number(),
  });
}

export const ResponseCreatedEventSchema = responseLifecycleEventSchema("response.created");
export const ResponseInProgressEventSchema = responseLifecycleEventSchema("response.in_progress");
export const ResponseCompletedEventSchema = responseLifecycleEventSchema("response.completed");
export const ResponseFailedEventSchema = responseLifecycleEventSchema("response.failed");
export const ResponseIncompleteEventSchema = responseLifecycleEventSchema("response.incomplete");

function outputItemEventSchema<T extends string>(type: T) {
  return z.object({
    type: z.literal(type),
    output_index: z.number(),
    item: OutputItemSchema,
    sequence_number: z.number(),
  });
}

export const OutputItemAddedEventSchema = outputItemEventSchema("response.output_item.added");
export const OutputItemDoneEventSchema = outputItemEventSchema("response.output_item.done");

function contentPartEventSchema<T extends string>(type: T) {
  return z.object({
    type: z.literal(type),
    item_id: z.string(),
    output_index: z.number(),
    content_index: z.number(),
    part: ContentPartSchema,
    sequence_number: z.number(),
  });
}

export const ContentPartAddedEventSchema = contentPartEventSchema("response.content_part.added");
export const ContentPartDoneEventSchema = contentPartEventSchema("response.content_part.done");

export const OutputTextDeltaEventSchema = z.object({
  type: z.literal("response.output_text.delta"),
  item_id: z.string(),
  output_index: z.number(),
  content_index: z.number(),
  delta: z.string(),
  sequence_number: z.number(),
});

export const OutputTextDoneEventSchema = z.object({
  type: z.literal("response.output_text.done"),
  item_id: z.string(),
  output_index: z.number(),
  content_index: z.number(),
  text: z.string(),
  sequence_number: z.number(),
});

export const OutputTextAnnotationAddedEventSchema = z.object({
  type: z.literal("response.output_text.annotation.added"),
  item_id: z.string(),
  output_index: z.number(),
  content_index: z.number(),
  annotation: AnnotationSchema,
  annotation_index: z.number(),
  sequence_number: z.number(),
});

function webSearchCallProgressEventSchema<T extends string>(type: T) {
  return z.object({
    type: z.literal(type),
    item_id: z.string(),
    output_index: z.number(),
    sequence_number: z.number(),
  });
}

export const WebSearchCallInProgressEventSchema = webSearchCallProgressEventSchema("response.web_search_call.in_progress");
export const WebSearchCallSearchingEventSchema = webSearchCallProgressEventSchema("response.web_search_call.searching");

export const WebSearchCallDoneEventSchema = z.object({
  type: z.literal("response.web_search_call.done"),
  item_id: z.string(),
  output_index: z.number(),
  item: WebSearchCallOutputItemSchema,
  sequence_number: z.number(),
});

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  sequence_number: z.number(),
});
