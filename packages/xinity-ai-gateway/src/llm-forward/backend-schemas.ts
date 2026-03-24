/**
 * Zod schemas for validating untrusted backend (inference node) responses.
 *
 * These cover the OpenAI-compatible response formats returned by vLLM, Ollama,
 * and other backends. All use `z.looseObject()` so unknown fields pass through
 * to the client without breaking validation.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const BackendUsageSchema = z.looseObject({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
  prompt_tokens_details: z.looseObject({
    cached_tokens: z.number().optional(),
  }).nullable().optional(),
  completion_tokens_details: z.looseObject({
    reasoning_tokens: z.number().optional(),
  }).nullable().optional(),
}).nullable().optional();

// ---------------------------------------------------------------------------
// Chat completions (/v1/chat/completions)
// ---------------------------------------------------------------------------

const ToolCallSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  index: z.number().optional(),
  function: z.looseObject({
    name: z.string(),
    arguments: z.string(),
  }),
});

const BackendMessageSchema = z.looseObject({
  role: z.string(),
  content: z.string().nullable().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  refusal: z.string().nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
  reasoning: z.string().optional(),
  annotations: z.array(z.unknown()).optional(),
});

export const BackendChatResponseSchema = z.looseObject({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  model: z.string(),
  system_fingerprint: z.string().nullable().optional(),
  choices: z.array(z.looseObject({
    index: z.number(),
    message: BackendMessageSchema,
    finish_reason: z.string().nullable().optional(),
    logprobs: z.unknown().nullable().optional(),
  })),
  usage: BackendUsageSchema,
});

const DeltaToolCallSchema = z.looseObject({
  id: z.string().optional(),
  type: z.string().optional(),
  index: z.number(),
  function: z.looseObject({
    name: z.string().optional(),
    arguments: z.string().optional(),
  }).optional(),
});

const BackendDeltaSchema = z.looseObject({
  role: z.string().optional(),
  content: z.string().nullable().optional(),
  tool_calls: z.array(DeltaToolCallSchema).optional(),
  refusal: z.string().nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
  reasoning: z.string().optional(),
});

export const BackendChatChunkSchema = z.looseObject({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  model: z.string(),
  system_fingerprint: z.string().nullable().optional(),
  choices: z.array(z.looseObject({
    index: z.number(),
    delta: BackendDeltaSchema,
    finish_reason: z.string().nullable().optional(),
    logprobs: z.unknown().nullable().optional(),
  })).default([]),
  usage: BackendUsageSchema,
});

// ---------------------------------------------------------------------------
// Legacy completions (/v1/completions)
// ---------------------------------------------------------------------------

export const BackendCompletionResponseSchema = z.looseObject({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  model: z.string(),
  system_fingerprint: z.string().nullable().optional(),
  choices: z.array(z.looseObject({
    index: z.number(),
    text: z.string(),
    logprobs: z.unknown().nullable().optional(),
    finish_reason: z.string().nullable().optional(),
  })),
  usage: BackendUsageSchema,
});

export const BackendCompletionChunkSchema = z.looseObject({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  model: z.string(),
  system_fingerprint: z.string().nullable().optional(),
  choices: z.array(z.looseObject({
    index: z.number(),
    text: z.string().default(""),
    logprobs: z.unknown().nullable().optional(),
    finish_reason: z.string().nullable().optional(),
  })).default([]),
  usage: BackendUsageSchema,
});

// ---------------------------------------------------------------------------
// Embeddings (/v1/embeddings)
// ---------------------------------------------------------------------------

export const BackendEmbeddingResponseSchema = z.looseObject({
  object: z.string(),
  data: z.array(z.looseObject({
    object: z.string(),
    embedding: z.unknown(),
    index: z.number(),
  })),
  model: z.string(),
  usage: z.looseObject({
    prompt_tokens: z.number(),
    total_tokens: z.number(),
  }).optional(),
});
