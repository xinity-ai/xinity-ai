import type { CreateResponseBody, OutputItem, ResponseObject, Usage } from "./schemas";

// ---------------------------------------------------------------------------
// Usage formatting
// ---------------------------------------------------------------------------

/** A loose union covering AI-SDK, OpenAI, and hybrid usage shapes. */
export type UsageInput = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  prompt_tokens?: number;
  completionTokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  outputTokenDetails?: { reasoningTokens?: number };
  reasoningTokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

/** Normalises AI-SDK / OpenAI usage objects into the Responses API shape. */
export function formatUsage(usage: UsageInput | null | undefined): Usage | null {
  if (!usage) return null;
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? usage.completion_tokens ?? 0;
  const totalTokens = usage.totalTokens ?? usage.total_tokens ?? inputTokens + outputTokens;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens
    ?? usage.reasoningTokens
    ?? usage.completion_tokens_details?.reasoning_tokens
    ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: reasoningTokens },
  };
}

// ---------------------------------------------------------------------------
// Response object construction
// ---------------------------------------------------------------------------

export type ResponsePayloadParams = {
  responseId: string;
  createdAt: number;
  model: string;
  status: "in_progress" | "completed" | "failed" | "incomplete" | "cancelled";
  output?: OutputItem[];
  usage?: UsageInput | null;
  body: CreateResponseBody;
};

/** Builds a full Responses API response object with all standard fields. */
export function createResponseObject(params: ResponsePayloadParams): ResponseObject {
  const { responseId, createdAt, model, status, output, usage, body } = params;
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    completed_at: status === "completed" ? Math.floor(Date.now() / 1000) : null,
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model,
    output: output ?? [],
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: body.reasoning
      ? { effort: body.reasoning.effort ?? null, summary: body.reasoning.summary ?? null }
      : null,
    store: body.store ?? true,
    temperature: body.temperature ?? null,
    text: { format: body.text?.format ?? { type: "text" } },
    tool_choice: body.tool_choice ?? "auto",
    tools: body.tools ?? [],
    top_p: body.top_p ?? null,
    truncation: body.truncation ?? "disabled",
    usage: formatUsage(usage),
    user: body.user ?? null,
    metadata: (body.metadata as Record<string, unknown>) ?? {},
  };
}

/** Marks a response object as failed with an error payload. */
export function markResponseFailed(response: ResponseObject, message: string): ResponseObject {
  return { ...response, status: "failed", error: { code: "server_error", message } };
}

