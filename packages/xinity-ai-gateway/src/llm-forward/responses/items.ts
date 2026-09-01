import type { ApiCallInputMessage } from "common-db";
import type {
  OutputItem,
  OutputTextContentPart,
  MessageOutputItem,
  WebSearchCallOutputItem,
  FunctionCallOutputItem,
  ReasoningOutputItem,
} from "./schemas";
import { generateCallId, INTERNAL_TOOL_NAMES, type ToolCallItem, type ToolResultData } from "./tools";

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
// Web search results
// ---------------------------------------------------------------------------

type WebSearchResultEntry = { url: string; title?: string };

function readWebSearchResults(value: unknown): WebSearchResultEntry[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as { results?: WebSearchResultEntry[] }).results;
}

export function readWebSearchQuery(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as { query?: string }).query;
}

/** Extracts URL-citation annotations from web search tool results. */
export function extractSearchAnnotations(toolResults: ToolResultData[]): OutputTextContentPart["annotations"] {
  return toolResults
    .filter((r) => r.toolName === "web_search")
    .flatMap((r) => readWebSearchResults(r.result) ?? [])
    .map((item) => ({ type: "url_citation" as const, url: item.url, title: item.title || "" }));
}

/**
 * Builds the complete `output` array for a finished response.
 *
 * Each `ToolCallItem` carries both a public `id` (exposed to the client) and
 * an `aiToolCallId` (the AI SDK's internal identifier). Results are matched
 * via `aiToolCallId` since that's what the AI SDK attaches to tool results.
 */
function buildWebSearchCallItem(
  toolCall: ToolCallItem,
  toolResults: ToolResultData[],
  include?: IncludeValue[],
): WebSearchCallOutputItem {
  const result = toolResults.find((r) => r.toolCallId === toolCall.aiToolCallId);
  const searchResults = readWebSearchResults(result?.result);
  const action: NonNullable<WebSearchCallOutputItem["action"]> = {
    type: "search",
    query: readWebSearchQuery(result?.args) ?? "",
  };
  if (searchResults && shouldInclude(include, "web_search_call.action.sources")) {
    action.sources = searchResults.map((r) => ({ type: "url_citation" as const, url: r.url, title: r.title ?? "" }));
  }
  const item: WebSearchCallOutputItem = {
    id: toolCall.id,
    type: "web_search_call",
    status: toolCall.status,
    action,
  };
  if (searchResults && shouldInclude(include, "web_search_call.results")) {
    item.results = searchResults;
  }
  return item;
}

function buildFunctionCallItem(toolCall: ToolCallItem): FunctionCallOutputItem {
  return {
    id: toolCall.id,
    type: "function_call",
    status: toolCall.status,
    call_id: toolCall.callId ?? toolCall.aiToolCallId,
    name: toolCall.name ?? "",
    arguments: toolCall.arguments ?? "{}",
  };
}

// ---------------------------------------------------------------------------
// Input items
// ---------------------------------------------------------------------------

/** Item ids double as the `after` cursor, so they must encode position, not content:
 * deduplication means the same body can appear at more than one position. */
export const inputItemId = (responseId: string, seq: number) => `msg_${responseId}_${seq}`;

export function parseInputItemCursor(responseId: string, cursor: string): number | null {
  const prefix = `msg_${responseId}_`;
  if (!cursor.startsWith(prefix)) {
    return null;
  }
  const seq = Number(cursor.slice(prefix.length));
  return Number.isInteger(seq) && seq >= 0 ? seq : null;
}

function toInputContentParts(content: ApiCallInputMessage["content"]) {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((part) =>
    part.type === "image_url"
      ? { type: "input_image", image_url: part.image_url.url }
      : { type: "input_text", text: part.text },
  );
}

/** Renders stored input messages the way the Responses API describes items, which is not
 * the chat shape they were stored in: text becomes `input_text`, and `input_image` carries
 * a bare URL rather than chat's nested object. */
export function buildInputItems(
  responseId: string,
  messages: Array<{ seq: number; body: ApiCallInputMessage }>,
): Array<Record<string, unknown>> {
  return messages.map(({ seq, body }) => {
    const id = inputItemId(responseId, seq);

    if (body.role === "tool") {
      return {
        id,
        type: "function_call_output",
        call_id: body.tool_call_id ?? null,
        output: typeof body.content === "string" ? body.content : JSON.stringify(body.content ?? ""),
      };
    }

    if (body.tool_calls?.length) {
      const [call] = body.tool_calls;
      return {
        id,
        type: "function_call",
        status: "completed",
        call_id: call?.id ?? null,
        name: call?.function.name ?? "",
        arguments: call?.function.arguments ?? "{}",
      };
    }

    return { id, type: "message", role: body.role, content: toInputContentParts(body.content) };
  });
}

// ---------------------------------------------------------------------------
// Output items
// ---------------------------------------------------------------------------

export function buildReasoningItem(responseId: string, reasoningText: string, index: number): ReasoningOutputItem {
  return {
    id: `rs_${responseId}_${index}`,
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: reasoningText }],
    content: [],
  };
}

export function buildOutputItems(
  responseId: string,
  text: string,
  toolCalls: ToolCallItem[],
  toolResults: ToolResultData[],
  include?: IncludeValue[],
  reasoningTexts: string[] = [],
): OutputItem[] {
  const output: OutputItem[] = [];

  reasoningTexts.forEach((reasoningText, index) => {
    if (reasoningText) {
      output.push(buildReasoningItem(responseId, reasoningText, index));
    }
  });

  for (const toolCall of toolCalls) {
    if (toolCall.type === "web_search_call") {
      output.push(buildWebSearchCallItem(toolCall, toolResults, include));
    } else if (toolCall.type === "function_call") {
      output.push(buildFunctionCallItem(toolCall));
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

/**
 * Builds output items from a single onStepFinish event. Used by deep research
 * to persist progress incrementally after each step.
 */
export function buildStepOutputItems(
  stepToolCalls: Array<{ toolCallId: string; toolName: string; input?: unknown }> | undefined,
  stepToolResults: Array<Record<string, unknown>> | undefined,
  include?: IncludeValue[],
): OutputItem[] {
  if (!stepToolCalls) return [];

  const results: ToolResultData[] = [];
  if (stepToolResults) {
    for (const tr of stepToolResults) {
      const callId = tr.toolCallId;
      const name = tr.toolName;
      if (typeof callId === "string" && typeof name === "string") {
        results.push({ toolCallId: callId, toolName: name, args: tr.input, result: tr.output });
      }
    }
  }

  const items: OutputItem[] = [];
  for (const tc of stepToolCalls) {
    const toolCallId = typeof tc.toolCallId === "string" ? tc.toolCallId : "";
    const toolName = typeof tc.toolName === "string" ? tc.toolName : "";
    if (!toolCallId) continue;

    if (toolName === "web_search") {
      items.push(buildWebSearchCallItem(
        { id: generateCallId(), aiToolCallId: toolCallId, type: "web_search_call", status: "completed" },
        results, include,
      ));
    } else if (!INTERNAL_TOOL_NAMES.has(toolName)) {
      items.push(buildFunctionCallItem({
        id: generateCallId(),
        aiToolCallId: toolCallId,
        type: "function_call",
        status: "completed",
        name: toolName,
        callId: toolCallId,
        arguments: tc.input != null ? JSON.stringify(tc.input) : "{}",
      }));
    }
  }

  return items;
}

