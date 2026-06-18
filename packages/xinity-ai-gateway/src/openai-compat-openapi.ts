import { z } from "zod";
import type { OpenAPI } from "@orpc/openapi";
import { ChatCompletionBodySchema, ChatSyncChoiceSchema } from "./llm-forward/endpoints/handle-chatCompletion";
import { CompletionBodySchema, CompletionSyncChoiceSchema } from "./llm-forward/endpoints/handle-completions";
import { EmbeddingBodySchema } from "./llm-forward/endpoints/handle-embeddings";
import { RerankBodySchema } from "./llm-forward/endpoints/handle-rerank";
import { CreateResponseBodySchema, ResponseObjectSchema } from "./llm-forward/responses/schemas";

const TAG = "OpenAI Compatible";
const SECURITY = [{ bearerAuth: [] }];

const STORE_NOTE =
  "`store` (Xinity semantics): omit to defer to the API key's data-collection policy. `true`/`false` are explicit overrides that ignore the per-key policy.";
const APP_HEADER_NOTE =
  "`X-Application` request header (optional, Xinity extension): routes the call to a named application for organizing usage in the dashboard.";
const METADATA_NOTE =
  "`metadata` is surfaced in the Xinity dashboard as filterable tags on each call.";

function toSchema(schema: z.ZodTypeAny): OpenAPI.SchemaObject {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json as OpenAPI.SchemaObject;
}

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["message", "type"],
      properties: {
        message: { type: "string" },
        type: { type: "string" },
        code: { type: ["string", "null"] },
      },
    },
  },
};

const modelObjectSchema = {
  type: "object",
  additionalProperties: true,
  required: ["id", "object", "created", "owned_by", "status", "canary"],
  properties: {
    id: { type: "string" },
    object: { type: "string", enum: ["model"] },
    created: { type: "integer" },
    owned_by: { type: "string" },
    status: {
      type: ["string", "null"],
      enum: ["downloading", "installing", "ready", "failed", null],
      description: "Xinity extension. Aggregated installation lifecycle state across the deployment's replicas (best-state wins). `null` when no installation exists. Default `/v1/models` only returns deployments with `status: ready`; pass `?include_unavailable=true` to see the rest.",
    },
    canary: {
      type: "boolean",
      description: "Xinity extension. True while a canary rollout's progress is below 100%.",
    },
  },
};

const modelsListResponseSchema = {
  type: "object",
  required: ["object", "data"],
  properties: {
    object: { type: "string", enum: ["list"] },
    data: { type: "array", items: { $ref: "#/components/schemas/ModelObject" } },
  },
};

// Response shapes for the spec: authored in Zod, converted via `toSchema` like
// the requests. `looseObject` keeps them open (documentation, not validation).
const ChatTokenLogprobSchema = z.looseObject({
  token: z.string(),
  logprob: z.number(),
  bytes: z.array(z.number().int()).nullable(),
  top_logprobs: z.array(z.looseObject({
    token: z.string(),
    logprob: z.number(),
    bytes: z.array(z.number().int()).nullable(),
  })),
});
const ChatLogprobsSchema = z.looseObject({
  content: z.array(ChatTokenLogprobSchema).nullable(),
  refusal: z.array(ChatTokenLogprobSchema).nullable(),
});

// Legacy completions logprobs: parallel arrays, not chat's per-token objects.
const CompletionLogprobsSchema = z.looseObject({
  tokens: z.array(z.string()),
  token_logprobs: z.array(z.number()),
  top_logprobs: z.array(z.record(z.string(), z.number())).nullable(),
  text_offset: z.array(z.number().int()),
});

const ChatUsageSchema = z.looseObject({
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  total_tokens: z.number().int(),
});

const ChatCompletionResponseSchema = z.looseObject({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(z.looseObject({ ...ChatSyncChoiceSchema.shape, logprobs: ChatLogprobsSchema.nullable().optional() })),
  usage: ChatUsageSchema.optional(),
});

const CompletionResponseSchema = z.looseObject({
  id: z.string(),
  object: z.literal("text_completion"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(z.looseObject({ ...CompletionSyncChoiceSchema.shape, logprobs: CompletionLogprobsSchema.nullable().optional() })),
  usage: ChatUsageSchema.optional(),
});

const EmbeddingResponseSchema = z.looseObject({
  object: z.literal("list"),
  data: z.array(z.looseObject({
    object: z.literal("embedding"),
    index: z.number().int(),
    embedding: z.array(z.number()),
  })),
  model: z.string(),
  usage: ChatUsageSchema.optional(),
});

const RerankResponseSchema = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  results: z.array(z.looseObject({
    index: z.number().int(),
    relevance_score: z.number(),
    document: z.looseObject({ text: z.string() }).optional(),
  })),
  usage: ChatUsageSchema.optional(),
});

const TranscriptionResponseSchema = z.looseObject({
  text: z.string(),
  language: z.string().optional(),
  duration: z.number().optional(),
  segments: z.array(z.looseObject({
    id: z.number().int(),
    start: z.number(),
    end: z.number(),
    text: z.string(),
  })).optional(),
  words: z.array(z.looseObject({
    word: z.string(),
    start: z.number(),
    end: z.number(),
  })).optional(),
});

// SSE events emitted when `stream: true`.
const TranscriptTextDeltaEventSchema = z.looseObject({
  type: z.literal("transcript.text.delta"),
  delta: z.string(),
});
const TranscriptTextDoneEventSchema = z.looseObject({
  type: z.literal("transcript.text.done"),
  text: z.string(),
  usage: z.looseObject({
    type: z.literal("tokens"),
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    total_tokens: z.number().int(),
  }).optional(),
});

function jsonContent(schemaRef: string) {
  return { "application/json": { schema: { $ref: schemaRef } } };
}

function jsonResponse(description: string, schemaRef: string) {
  return { description, content: jsonContent(schemaRef) };
}

const errorJsonContent = jsonContent("#/components/schemas/Error");
const errorResponses = {
  "400": { description: "Bad request", content: errorJsonContent },
  "401": { description: "Missing or invalid API key", content: errorJsonContent },
  "403": { description: "Forbidden", content: errorJsonContent },
  "404": { description: "Not found", content: errorJsonContent },
  "429": { description: "Backend queue is full; retry with backoff", content: errorJsonContent },
  "500": { description: "Internal server error", content: errorJsonContent },
  "502": { description: "Bad gateway from inference backend", content: errorJsonContent },
  "503": { description: "Backend unavailable", content: errorJsonContent },
  "504": { description: "Backend timed out", content: errorJsonContent },
};

const sseContent = {
  "text/event-stream": { schema: { type: "string" } },
};

function jsonRequest(schemaRef: string) {
  return {
    required: true,
    content: jsonContent(schemaRef),
  };
}

function streamableJsonResponse(description: string, schemaRef: string) {
  return {
    description,
    content: { ...jsonContent(schemaRef), ...sseContent },
  };
}

export const openaiCompatSchemas = {
  Error: errorResponseSchema,
  ModelObject: modelObjectSchema,
  ModelsListResponse: modelsListResponseSchema,
  ChatCompletionRequest: toSchema(ChatCompletionBodySchema),
  ChatCompletionResponse: toSchema(ChatCompletionResponseSchema),
  CompletionRequest: toSchema(CompletionBodySchema),
  CompletionResponse: toSchema(CompletionResponseSchema),
  EmbeddingRequest: toSchema(EmbeddingBodySchema),
  EmbeddingResponse: toSchema(EmbeddingResponseSchema),
  RerankRequest: toSchema(RerankBodySchema),
  RerankResponse: toSchema(RerankResponseSchema),
  TranscriptionResponse: toSchema(TranscriptionResponseSchema),
  TranscriptTextDeltaEvent: toSchema(TranscriptTextDeltaEventSchema),
  TranscriptTextDoneEvent: toSchema(TranscriptTextDoneEventSchema),
  CreateResponseRequest: toSchema(CreateResponseBodySchema),
  ResponseObject: toSchema(ResponseObjectSchema),
} as Record<string, OpenAPI.SchemaObject>;

export const openaiCompatPaths = {
  "/v1/models": {
    get: {
      tags: [TAG],
      summary: "List models",
      description: [
        "OpenAI: https://platform.openai.com/docs/api-reference/models/list",
        "",
        "Xinity differences:",
        "- Defaults to filtering for `status: ready` deployments. Pass `?include_unavailable=true` to also receive `downloading`, `installing`, `failed`, and pending deployments.",
        "- Each item carries Xinity extension fields `status` and `canary` (see ModelObject).",
      ].join("\n"),
      security: SECURITY,
      parameters: [
        {
          name: "include_unavailable",
          in: "query",
          required: false,
          description: "Include deployments whose lifecycle state is not `ready`. Accepts `true` or `1`.",
          schema: { type: "boolean", default: false },
        },
      ],
      responses: {
        "200": jsonResponse("List of models", "#/components/schemas/ModelsListResponse"),
        ...errorResponses,
      },
    },
  },
  "/v1/chat/completions": {
    post: {
      tags: [TAG],
      summary: "Create a chat completion",
      description: [
        "OpenAI: https://platform.openai.com/docs/api-reference/chat/create",
        "",
        "Xinity differences:",
        `- ${STORE_NOTE}`,
        `- ${METADATA_NOTE}`,
        "- `structured_outputs` is only honored for vLLM-driven models; rejected with 400 otherwise.",
        `- ${APP_HEADER_NOTE}`,
      ].join("\n"),
      security: SECURITY,
      requestBody: jsonRequest("#/components/schemas/ChatCompletionRequest"),
      responses: {
        "200": streamableJsonResponse(
          "Chat completion, or SSE stream when `stream: true`",
          "#/components/schemas/ChatCompletionResponse",
        ),
        ...errorResponses,
      },
    },
  },
  "/v1/completions": {
    post: {
      tags: [TAG],
      summary: "Create a text completion (legacy)",
      description: [
        "OpenAI: https://platform.openai.com/docs/api-reference/completions/create",
        "",
        "Xinity differences:",
        `- ${STORE_NOTE}`,
        `- ${METADATA_NOTE}`,
        `- ${APP_HEADER_NOTE}`,
      ].join("\n"),
      security: SECURITY,
      requestBody: jsonRequest("#/components/schemas/CompletionRequest"),
      responses: {
        "200": streamableJsonResponse(
          "Text completion, or SSE stream when `stream: true`",
          "#/components/schemas/CompletionResponse",
        ),
        ...errorResponses,
      },
    },
  },
  "/v1/embeddings": {
    post: {
      tags: [TAG],
      summary: "Create embeddings",
      description: [
        "OpenAI: https://platform.openai.com/docs/api-reference/embeddings/create",
        "",
        "Xinity differences:",
        `- ${APP_HEADER_NOTE}`,
        "- Embedding call payloads are never persisted regardless of API key policy.",
      ].join("\n"),
      security: SECURITY,
      requestBody: jsonRequest("#/components/schemas/EmbeddingRequest"),
      responses: {
        "200": jsonResponse("Embedding vectors", "#/components/schemas/EmbeddingResponse"),
        ...errorResponses,
      },
    },
  },
  "/v1/rerank": {
    post: {
      tags: [TAG],
      summary: "Rerank documents by relevance to a query",
      description: [
        "Cohere v1 rerank: https://docs.cohere.com/v1/reference/rerank",
        "",
        "Xinity notes:",
        "- Only available for deployments whose model type is `rerank`.",
        `- ${APP_HEADER_NOTE}`,
      ].join("\n"),
      security: SECURITY,
      requestBody: jsonRequest("#/components/schemas/RerankRequest"),
      responses: {
        "200": jsonResponse("Reranked documents", "#/components/schemas/RerankResponse"),
        ...errorResponses,
      },
    },
  },
  "/v1/audio/transcriptions": {
    post: {
      tags: [TAG],
      summary: "Transcribe audio to text",
      description: [
        "OpenAI: https://platform.openai.com/docs/api-reference/audio/createTranscription",
        "",
        "Xinity notes:",
        "- Only available for deployments whose model type is `transcription` (e.g. Whisper).",
        `- ${APP_HEADER_NOTE}`,
        "- `response_format` `json` (default) and `verbose_json` return JSON; `text`/`srt`/`vtt` return the raw text body.",
      ].join("\n"),
      security: SECURITY,
      // Hand-written: a multipart binary upload can't be derived from a Zod schema.
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file", "model"],
              properties: {
                file: { type: "string", format: "binary", description: "The audio file to transcribe." },
                model: { type: "string" },
                language: { type: "string", description: "Input language as an ISO-639-1 code (optional; improves accuracy)." },
                prompt: { type: "string", description: "Optional text to guide the model's style or continue a prior segment." },
                response_format: { type: "string", enum: ["json", "text", "srt", "verbose_json", "vtt"], default: "json" },
                temperature: { type: "number" },
                stream: { type: "boolean", default: false, description: "Stream the transcription as SSE `transcript.text.delta` then `transcript.text.done` events." },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Transcription. JSON for `json`/`verbose_json`; the raw `text`/`srt`/`vtt` body; or, when `stream: true`, an SSE stream of `transcript.text.delta` events ending with `transcript.text.done`.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/TranscriptionResponse" } },
            "text/plain": { schema: { type: "string" } },
            "text/event-stream": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/TranscriptTextDeltaEvent" },
                  { $ref: "#/components/schemas/TranscriptTextDoneEvent" },
                ],
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },
  "/v1/responses": {
    post: {
      tags: [TAG],
      summary: "Create a response",
      description: [
        "OpenAI: https://platform.openai.com/docs/api-reference/responses/create",
        "",
        "Xinity differences:",
        `- ${STORE_NOTE}`,
        `- ${METADATA_NOTE}`,
        "- Supported tool types: `function`, plus `web_search` (and the `web_search_preview*` aliases). Other built-in tools are not implemented.",
        `- ${APP_HEADER_NOTE}`,
      ].join("\n"),
      security: SECURITY,
      requestBody: jsonRequest("#/components/schemas/CreateResponseRequest"),
      responses: {
        "200": streamableJsonResponse(
          "Completed response, or SSE stream when `stream: true`",
          "#/components/schemas/ResponseObject",
        ),
        "202": jsonResponse("Accepted; response is being generated in the background (`background: true`)", "#/components/schemas/ResponseObject"),
        ...errorResponses,
      },
    },
  },
  "/v1/responses/{responseId}": {
    parameters: [
      {
        name: "responseId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    get: {
      tags: [TAG],
      summary: "Retrieve a stored response",
      description: "OpenAI: https://platform.openai.com/docs/api-reference/responses/get",
      security: SECURITY,
      responses: {
        "200": jsonResponse("The stored response object", "#/components/schemas/ResponseObject"),
        ...errorResponses,
      },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a stored response",
      description: "OpenAI: https://platform.openai.com/docs/api-reference/responses/delete",
      security: SECURITY,
      responses: {
        "200": {
          description: "Deletion confirmation",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "object", "deleted"],
                properties: {
                  id: { type: "string" },
                  object: { type: "string", enum: ["response"] },
                  deleted: { type: "boolean" },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  },
} as unknown as OpenAPI.PathsObject;

export const openaiCompatTags: OpenAPI.TagObject[] = [
  {
    name: TAG,
    description:
      "Endpoints under `/v1/*` that mirror the OpenAI (and, for `/v1/rerank`, Cohere v1) APIs. Point an OpenAI client's `baseURL` at this gateway's `/v1`. Each operation links to the upstream reference; only Xinity-specific differences are documented inline.",
  },
];

export const openaiCompatSecuritySchemes: Record<string, OpenAPI.SecuritySchemeObject> = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    description: "Xinity API key, sent as `Authorization: Bearer <key>`.",
  },
};
