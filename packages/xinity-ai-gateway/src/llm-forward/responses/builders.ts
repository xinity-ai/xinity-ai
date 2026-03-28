import { Output, tool, jsonSchema, type ModelMessage, type ToolSet } from "ai";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { responseTools, type ResponseToolName, RESPONSE_TOOL_NAMES } from "../tools/response-tools";
import type {
  CreateResponseBody,
  ResponseObject,
  OutputItem,
  OutputTextContentPart,
  MessageOutputItem,
  WebSearchCallOutputItem,
  FunctionCallOutputItem,
  Usage,
} from "./schemas";

// ---------------------------------------------------------------------------
// Include parameter
// ---------------------------------------------------------------------------

export const SUPPORTED_INCLUDE_VALUES = [
  "web_search_call.action.sources",
  "web_search_call.results",
  "file_search_call.results",
  "code_interpreter_call.outputs",
  "computer_call_output.output.image_url",
  "message.input_image.image_url",
  "reasoning.encrypted_content",
  "message.output_text.logprobs",
] as const;

export type IncludeValue = (typeof SUPPORTED_INCLUDE_VALUES)[number];

export function shouldInclude(include: IncludeValue[] | undefined, value: IncludeValue): boolean {
  return include?.includes(value) ?? false;
}

// ---------------------------------------------------------------------------
// Tool call tracking
// ---------------------------------------------------------------------------

export type ToolCallItem = {
  /** Stable ID exposed in the Responses API output (e.g. `call_abc123…`). */
  id: string;
  /** The AI SDK's internal tool call ID, used to match results back to calls. */
  aiToolCallId: string;
  type: "web_search_call" | "function_call";
  status: "in_progress" | "completed" | "failed";
  /** Function tool name (only for function_call). */
  name?: string;
  /** The AI SDK tool call ID used as the Responses API call_id (only for function_call). */
  callId?: string;
  /** Serialized JSON arguments (only for function_call). */
  arguments?: string;
};

export type ToolResultData = {
  /** The AI SDK's internal tool call ID that produced this result. */
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
};

export function generateCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Internal helper tools that should not appear as visible output items. */
const INTERNAL_TOOL_NAMES = new Set(["web_fetch"]);

/**
 * Creates an `onStepFinish` callback for non-streaming `generateText` that
 * accumulates tool calls and their results across multi-step runs.
 *
 * The AI SDK fires `onStepFinish` after each tool-use loop iteration with
 * arrays of the tool calls and results from that step. This tracker:
 *
 * 1. Builds `web_search_call` items for web_search, `function_call` items for
 *    user-defined function tools, and ignores internal helpers like `web_fetch`.
 * 2. Generates a stable public `call_*` ID for each, and records the AI SDK's
 *    internal `toolCallId` so `buildOutputItems` can later match results.
 * 3. Collects all tool results (including `web_fetch`) so annotations and
 *    search results can be extracted regardless of the tool that produced them.
 */
export function createToolTracker(toolCalls: ToolCallItem[], toolResults: ToolResultData[]) {
  return ({ toolCalls: stepToolCalls, toolResults: stepToolResults }: {
    toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
    toolResults?: Array<Record<string, unknown>>;
  }) => {
    if (stepToolCalls) {
      for (const tc of stepToolCalls) {
        const toolCallId = typeof tc.toolCallId === "string" ? tc.toolCallId : "";
        const toolName = typeof tc.toolName === "string" ? tc.toolName : "";
        if (!toolCallId) continue;

        if (toolName === "web_search") {
          toolCalls.push({
            id: generateCallId(),
            aiToolCallId: toolCallId,
            type: "web_search_call",
            status: "completed",
          });
        } else if (!INTERNAL_TOOL_NAMES.has(toolName)) {
          // User-defined function tool
          const args = tc.input != null ? JSON.stringify(tc.input) : "{}";
          toolCalls.push({
            id: generateCallId(),
            aiToolCallId: toolCallId,
            type: "function_call",
            status: "completed",
            name: toolName,
            callId: toolCallId,
            arguments: args,
          });
        }
      }
    }
    if (stepToolResults) {
      for (const tr of stepToolResults) {
        const toolCallId = typeof tr.toolCallId === "string" ? tr.toolCallId : "";
        const toolName = typeof tr.toolName === "string" ? tr.toolName : "";
        if (!toolCallId || !toolName) continue;
        toolResults.push({ toolCallId, toolName, args: tr.input, result: tr.output });
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Tool resolution
// ---------------------------------------------------------------------------

export type FunctionToolDefinition = {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
};

function parseBuiltinToolNames(tools: unknown[]): ResponseToolName[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      if (typeof t === "string" && RESPONSE_TOOL_NAMES.includes(t as ResponseToolName))
        return t as ResponseToolName;
      if (typeof t === "object" && t !== null && "type" in t) {
        const type = (t as { type: string }).type;
        if (RESPONSE_TOOL_NAMES.includes(type as ResponseToolName)) return type as ResponseToolName;
      }
      return null;
    })
    .filter((t): t is ResponseToolName => t !== null);
}

/** Extracts function tool definitions from the tools array. */
export function parseFunctionTools(tools: unknown[]): FunctionToolDefinition[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t): t is { type: string; name: string; [key: string]: unknown } =>
      typeof t === "object" && t !== null &&
      "type" in t && (t as { type: unknown }).type === "function" &&
      "name" in t && typeof (t as { name: unknown }).name === "string",
    )
    .map((t) => ({
      type: "function" as const,
      name: t.name,
      description: typeof t.description === "string" ? t.description : undefined,
      parameters: typeof t.parameters === "object" && t.parameters !== null
        ? t.parameters as Record<string, unknown> : undefined,
      strict: typeof t.strict === "boolean" ? t.strict : undefined,
    }));
}

/** Converts function tool definitions to AI SDK tool objects (manual, no execute). */
export function buildFunctionToolSet(functionTools: FunctionToolDefinition[]): ToolSet {
  const toolSet: ToolSet = {};
  for (const ft of functionTools) {
    toolSet[ft.name] = tool({
      description: ft.description ?? "",
      inputSchema: ft.parameters ? jsonSchema(ft.parameters) : jsonSchema({ type: "object" }),
    });
    // No execute function → "manual" tool in AI SDK: model can call it but
    // the SDK returns the call without executing, stopping the tool loop.
  }
  return toolSet;
}

export type ResolvedTools = {
  activeTools: ToolSet;
  hasFunctionTools: boolean;
  hasBuiltinTools: boolean;
};

/** Determines which tools to activate based on `tools` and `tool_choice`. */
export function resolveActiveTools(
  tools: unknown[],
  toolChoice: unknown,
): ResolvedTools {
  let builtinNames: ResponseToolName[];
  if (toolChoice === "none") {
    builtinNames = [];
  } else if (typeof toolChoice === "string" && RESPONSE_TOOL_NAMES.includes(toolChoice as ResponseToolName)) {
    builtinNames = [toolChoice as ResponseToolName];
  } else if (typeof toolChoice === "object" && toolChoice !== null && "type" in toolChoice) {
    const t = (toolChoice as { type: string }).type;
    builtinNames = RESPONSE_TOOL_NAMES.includes(t as ResponseToolName) ? [t as ResponseToolName] : parseBuiltinToolNames(tools);
  } else {
    builtinNames = parseBuiltinToolNames(tools);
  }

  const activeTools: ToolSet = {};

  // Built-in tools (with execute functions — auto-executed by AI SDK)
  if (builtinNames.includes("web_search")) activeTools["web_fetch"] = responseTools["web_fetch"];
  for (const name of builtinNames) {
    if (name in responseTools) activeTools[name] = responseTools[name];
  }
  const hasBuiltinTools = Object.keys(activeTools).length > 0;

  // Function tools (manual — no execute, AI SDK returns them to caller)
  const functionTools = toolChoice === "none" ? [] : parseFunctionTools(tools);
  const functionToolSet = buildFunctionToolSet(functionTools);
  Object.assign(activeTools, functionToolSet);

  return {
    activeTools,
    hasFunctionTools: functionTools.length > 0,
    hasBuiltinTools,
  };
}

// ---------------------------------------------------------------------------
// Output config (structured output / json schema)
// ---------------------------------------------------------------------------

export type TextConfig = {
  format?: {
    type?: string;
    json_schema?: { name?: string; schema?: unknown };
  };
};

export type OutputConfig = {
  output?: ReturnType<typeof Output.text> | ReturnType<typeof Output.object> | ReturnType<typeof Output.json>;
  usesStructuredOutput: boolean;
};

/** Maps the `text.format` request field to the AI-SDK output mode. */
export function buildOutputConfig(textConfig: TextConfig | null): OutputConfig {
  const formatType = textConfig?.format?.type ?? "text";
  if (formatType === "json_schema" && textConfig?.format?.json_schema?.schema) {
    return {
      output: Output.object({
        schema: jsonSchema(textConfig.format.json_schema.schema),
        name: textConfig.format.json_schema.name,
      }),
      usesStructuredOutput: true,
    };
  }
  if (formatType === "json" || formatType === "json_object") {
    return { output: Output.json(), usesStructuredOutput: true };
  }
  return { output: Output.text(), usesStructuredOutput: false };
}

/**
 * If structured output was requested, serialize the parsed object; otherwise
 * pass text through.
 *
 * `getOutput` is a thunk so that the AI-SDK lazy getter (`result.output`) is
 * only evaluated when we actually need it. Eagerly passing `result.output` as
 * a plain value triggers the getter unconditionally and throws
 * `NoOutputGeneratedError` when the model returned no structured content.
 */
export function resolveResponseText(text: string, getOutput: () => unknown, usesStructuredOutput: boolean): string {
  if (usesStructuredOutput) {
    try {
      const output = getOutput();
      if (output !== undefined) {
        return JSON.stringify(output);
      }
    } catch {
      // AI SDK throws NoOutputGeneratedError when the model didn't produce
      // structured output. Fall through to return raw text instead of crashing.
    }
  }
  return text;
}

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
};

/** Normalises AI-SDK / OpenAI usage objects into the Responses API shape. */
export function formatUsage(usage: UsageInput | null | undefined): Usage | null {
  if (!usage) return null;
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? usage.completion_tokens ?? 0;
  const totalTokens = usage.totalTokens ?? usage.total_tokens ?? inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Response object construction
// ---------------------------------------------------------------------------

export interface ResponsePayloadParams {
  responseId: string;
  createdAt: number;
  model: string;
  status: "in_progress" | "completed" | "failed" | "incomplete";
  output?: OutputItem[];
  usage?: UsageInput | null;
  body: CreateResponseBody;
}

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
    text: body.text ? { format: body.text.format ?? { type: "text" } } : { format: { type: "text" } },
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

// ---------------------------------------------------------------------------
// Output item construction
// ---------------------------------------------------------------------------

/** Extracts URL-citation annotations from web search tool results. */
export function extractSearchAnnotations(toolResults: ToolResultData[]): OutputTextContentPart["annotations"] {
  const annotations: OutputTextContentPart["annotations"] = [];
  for (const r of toolResults.filter((r) => r.toolName === "web_search")) {
    if (r.result && typeof r.result === "object") {
      const data = r.result as { results?: Array<{ url: string; title?: string }> };
      for (const item of data.results ?? []) {
        annotations.push({ type: "url_citation", url: item.url, title: item.title || "" });
      }
    }
  }
  return annotations;
}

/**
 * Builds the complete `output` array for a finished response.
 *
 * Each `ToolCallItem` carries both a public `id` (exposed to the client) and
 * an `aiToolCallId` (the AI SDK's internal identifier). Results are matched
 * via `aiToolCallId` since that's what the AI SDK attaches to tool results.
 */
export function buildOutputItems(
  responseId: string,
  text: string,
  toolCalls: ToolCallItem[],
  toolResults: ToolResultData[],
  include?: IncludeValue[],
): OutputItem[] {
  const output: OutputItem[] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.type === "web_search_call") {
      const item: WebSearchCallOutputItem = { id: toolCall.id, type: "web_search_call", status: toolCall.status };
      const result = toolResults.find((r) => r.toolCallId === toolCall.aiToolCallId);

      // Always populate action with type and query so consumers know what was searched
      const query = result?.args && typeof result.args === "object"
        ? (result.args as { query?: string }).query : undefined;
      item.action = { type: "search", query: query ?? "" };

      if (shouldInclude(include, "web_search_call.results")) {
        if (result?.result && typeof result.result === "object") {
          const data = result.result as { results?: unknown[] };
          if (data.results) item.results = data.results;
        }
      }

      if (shouldInclude(include, "web_search_call.action.sources")) {
        if (result?.result && typeof result.result === "object") {
          const data = result.result as { results?: Array<{ url: string; title: string }> };
          if (data.results) {
            item.action.sources = data.results.map((r) => ({ type: "url_citation" as const, url: r.url, title: r.title }));
          }
        }
      }

      output.push(item);
    } else if (toolCall.type === "function_call") {
      const item: FunctionCallOutputItem = {
        id: toolCall.id,
        type: "function_call",
        status: toolCall.status,
        call_id: toolCall.callId ?? toolCall.aiToolCallId,
        name: toolCall.name ?? "",
        arguments: toolCall.arguments ?? "{}",
      };
      output.push(item);
    }
  }

  const annotations = extractSearchAnnotations(toolResults);
  const messageItem: MessageOutputItem = {
    id: `msg_${responseId}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations, logprobs: null }],
  };
  output.push(messageItem);

  return output;
}

// ---------------------------------------------------------------------------
// AI-SDK generation parameters
// ---------------------------------------------------------------------------

/** Assembles the common parameters shared by `generateText` and `streamText`. */
export function buildGenerationParams(
  body: CreateResponseBody,
  modelInfo: { model: string },
  provider: OpenAICompatibleProvider,
  messages: ModelMessage[],
  activeTools: ToolSet,
  hasTools: boolean,
  outputConfig: OutputConfig,
  signal?: AbortSignal,
) {
  return {
    model: provider.chatModel(modelInfo.model),
    messages,
    temperature: body.temperature,
    maxOutputTokens: body.max_output_tokens ?? body.max_tokens,
    topP: body.top_p,
    frequencyPenalty: body.frequency_penalty,
    presencePenalty: body.presence_penalty,
    seed: body.seed,
    abortSignal: signal,
    tools: hasTools ? activeTools : undefined,
    // Let the model decide when to stop calling tools (no artificial step limit).
    // The loop naturally ends when the model finishes without tool calls.
    stopWhen: hasTools ? (() => false) : undefined,
    output: outputConfig.output,
  };
}
