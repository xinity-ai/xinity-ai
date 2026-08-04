import { tool, jsonSchema, type ToolSet } from "ai";
import { responseTools, type ResponseToolName, RESPONSE_TOOL_NAMES } from "../tools/response-tools";

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
/** Tools we run on the caller's behalf without surfacing them as response items. */
export const INTERNAL_TOOL_NAMES = new Set(["web_fetch"]);

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

function isBuiltinToolName(value: unknown): value is ResponseToolName {
  return typeof value === "string" && RESPONSE_TOOL_NAMES.includes(value as ResponseToolName);
}

function parseBuiltinToolNames(tools: unknown[]): ResponseToolName[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      if (isBuiltinToolName(t)) return t;
      if (typeof t === "object" && t !== null && "type" in t && isBuiltinToolName((t as { type: unknown }).type)) {
        return (t as { type: ResponseToolName }).type;
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
      ...(ft.strict != null ? { strict: ft.strict } : {}),
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

function resolveBuiltinNames(tools: unknown[], toolChoice: unknown): ResponseToolName[] {
  if (toolChoice === "none") return [];
  if (isBuiltinToolName(toolChoice)) return [toolChoice];
  if (typeof toolChoice === "object" && toolChoice !== null && "type" in toolChoice) {
    const t = (toolChoice as { type: unknown }).type;
    if (isBuiltinToolName(t)) return [t];
  }
  return parseBuiltinToolNames(tools);
}

/** Determines which tools to activate based on `tools` and `tool_choice`. */
export function resolveActiveTools(
  tools: unknown[],
  toolChoice: unknown,
): ResolvedTools {
  const builtinNames = resolveBuiltinNames(tools, toolChoice);

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

