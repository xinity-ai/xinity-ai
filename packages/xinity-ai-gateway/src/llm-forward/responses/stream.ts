import type { StreamTextResult, LanguageModelUsage, ToolSet } from "ai";
import type {
  ResponseObject,
  OutputTextContentPart,
  MessageOutputItem,
  WebSearchCallOutputItem,
  FunctionCallOutputItem,
  CreateResponseBody,
} from "./schemas";
import type { ToolCallItem, ToolResultData, IncludeValue } from "./builders";
import {
  createResponseObject,
  buildOutputItems,
  extractSearchAnnotations,
  markResponseFailed,
  generateCallId,
} from "./builders";
import { saveResponse } from "../response-store";
import { rootLogger } from "../../logger";
import { isAbortError, isTimeoutError } from "../util";

const log = rootLogger.child({ name: "response-stream" });

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function emit(controller: ReadableStreamDefaultController, event: string, data: unknown) {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

// ---------------------------------------------------------------------------
// Sequence counter
// ---------------------------------------------------------------------------

function createSequence() {
  let n = 0;
  return () => n++;
}

// ---------------------------------------------------------------------------
// Inline tool call tracking
// ---------------------------------------------------------------------------

type StreamToolCall = {
  id: string;
  aiToolCallId: string;
  outputIndex: number;
  toolName: string;
  query?: string;
};

/** Internal helper tools that should not appear as visible output items. */
const INTERNAL_TOOL_NAMES = new Set(["web_fetch"]);

// ---------------------------------------------------------------------------
// Streaming entry point
// ---------------------------------------------------------------------------

export interface StreamResponseParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Output type varies per call site
  result: StreamTextResult<ToolSet, any>;
  orgId: string;
  responseId: string;
  messageItemId: string;
  createdAt: number;
  originalModel: string;
  body: CreateResponseBody;
  baseResponse: ResponseObject;
  toolCalls: ToolCallItem[];
  toolResults: ToolResultData[];
  include: IncludeValue[];
  onFinished: (usage: LanguageModelUsage, text: string) => void;
}

/**
 * Creates a ReadableStream that emits the full Responses API SSE event
 * sequence from an AI-SDK `streamText` result.
 */
export function createResponseStream(params: StreamResponseParams): ReadableStream {
  const {
    result, orgId, responseId, messageItemId, createdAt, originalModel, body,
    baseResponse, toolCalls, toolResults, include, onFinished,
  } = params;

  return new ReadableStream({
    async start(controller) {
      const seq = createSequence();
      let accumulatedText = "";
      let messageOutputIndex = -1;
      let nextOutputIndex = 0;
      let messageItemEmitted = false;

      // Track tool calls inline for consistent IDs across stream events
      const streamToolCalls: StreamToolCall[] = [];

      try {
        emitResponseCreated(controller, baseResponse, seq);
        emitResponseInProgress(controller, baseResponse, seq);

        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            if (!messageItemEmitted) {
              messageOutputIndex = nextOutputIndex++;
              messageItemEmitted = true;
              emitMessageItemAdded(controller, messageItemId, messageOutputIndex, seq);
              emitContentPartAdded(controller, messageItemId, messageOutputIndex, seq);
            }

            accumulatedText += part.text;
            emitTextDelta(controller, messageItemId, messageOutputIndex, part.text, seq);
          } else if (part.type === "tool-call") {
            if (part.toolName === "web_search") {
              const callId = generateCallId();
              const outputIdx = nextOutputIndex++;
              streamToolCalls.push({ id: callId, aiToolCallId: part.toolCallId, outputIndex: outputIdx, toolName: "web_search" });
              emitToolCallStarted(controller, callId, outputIdx, seq);
            } else if (!INTERNAL_TOOL_NAMES.has(part.toolName)) {
              // Function tool call (manual — no execute in AI SDK)
              const callId = generateCallId();
              const outputIdx = nextOutputIndex++;
              const argsStr = JSON.stringify(part.args ?? {});

              streamToolCalls.push({ id: callId, aiToolCallId: part.toolCallId, outputIndex: outputIdx, toolName: part.toolName });

              const functionItem: FunctionCallOutputItem = {
                id: callId, type: "function_call", status: "completed",
                call_id: part.toolCallId, name: part.toolName,
                arguments: argsStr,
              };
              emitFunctionCallEvents(controller, functionItem, outputIdx, seq);

              // Track for final output building
              toolCalls.push({
                id: callId, aiToolCallId: part.toolCallId,
                type: "function_call", status: "completed",
                name: part.toolName, callId: part.toolCallId,
                arguments: argsStr,
              });
            }
          } else if (part.type === "tool-result") {
            // Always record results for final response building
            toolResults.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.input,
              result: part.output,
            });

            // Emit completed events only for tracked web_search calls
            const match = streamToolCalls.find((tc) => tc.aiToolCallId === part.toolCallId);
            if (match && match.toolName === "web_search") {
              const query = part.input && typeof part.input === "object"
                ? (part.input as { query?: string }).query : undefined;
              match.query = query;
              toolCalls.push({ id: match.id, aiToolCallId: match.aiToolCallId, type: "web_search_call", status: "completed" });
              emitToolCallCompleted(controller, match.id, match.outputIndex, query, seq);
            }
          }
        }

        // Stream fully consumed, usage is now available
        const finalUsage = await result.usage;
        const finalText = accumulatedText || await result.text;

        if (!messageItemEmitted) {
          messageOutputIndex = nextOutputIndex++;
          emitMessageItemAdded(controller, messageItemId, messageOutputIndex, seq);
          emitContentPartAdded(controller, messageItemId, messageOutputIndex, seq);
        }

        const annotations = extractSearchAnnotations(toolResults);
        emitMessageFinished(controller, messageItemId, messageOutputIndex, finalText, annotations, seq);

        const completedResponse = createResponseObject({
          responseId, createdAt, model: originalModel, status: "completed",
          output: buildOutputItems(responseId, finalText, toolCalls, toolResults, include),
          usage: finalUsage, body,
        });
        await saveResponse(orgId, responseId, completedResponse)
          .catch((err) => log.error({ err, responseId }, "Failed to persist completed response"));
        onFinished(finalUsage, finalText);

        emitResponseCompleted(controller, completedResponse, seq);
        controller.close();
      } catch (error) {
        if (isAbortError(error) || isTimeoutError(error)) {
          try { controller.close(); } catch {}
          return;
        }
        const message = error instanceof Error ? error.message : "Gateway error";
        try {
          emitStreamError(controller, message, seq);
          emitResponseFailed(controller, markResponseFailed(baseResponse, message), seq);
          controller.close();
        } catch {
          try { controller.error(error as Error); } catch {}
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Individual event emitters, one per spec event type
// ---------------------------------------------------------------------------

function emitResponseCreated(
  ctrl: ReadableStreamDefaultController,
  response: ResponseObject,
  seq: () => number,
) {
  emit(ctrl, "response.created", {
    type: "response.created",
    response,
    sequence_number: seq(),
  });
}

function emitResponseInProgress(
  ctrl: ReadableStreamDefaultController,
  response: ResponseObject,
  seq: () => number,
) {
  emit(ctrl, "response.in_progress", {
    type: "response.in_progress",
    response,
    sequence_number: seq(),
  });
}

function emitMessageItemAdded(
  ctrl: ReadableStreamDefaultController,
  messageItemId: string,
  outputIndex: number,
  seq: () => number,
) {
  emit(ctrl, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { id: messageItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
    sequence_number: seq(),
  });
}

function emitContentPartAdded(
  ctrl: ReadableStreamDefaultController,
  messageItemId: string,
  outputIndex: number,
  seq: () => number,
) {
  emit(ctrl, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: messageItemId,
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
    sequence_number: seq(),
  });
}

function emitTextDelta(
  ctrl: ReadableStreamDefaultController,
  messageItemId: string,
  outputIndex: number,
  delta: string,
  seq: () => number,
) {
  emit(ctrl, "response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: messageItemId,
    output_index: outputIndex,
    content_index: 0,
    delta,
    sequence_number: seq(),
  });
}

function emitToolCallStarted(
  ctrl: ReadableStreamDefaultController,
  toolCallId: string,
  outputIndex: number,
  seq: () => number,
) {
  const toolItem: WebSearchCallOutputItem = { id: toolCallId, type: "web_search_call", status: "in_progress" };

  emit(ctrl, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: toolItem,
    sequence_number: seq(),
  });
  emit(ctrl, "response.web_search_call.in_progress", {
    type: "response.web_search_call.in_progress",
    item_id: toolCallId,
    output_index: outputIndex,
    sequence_number: seq(),
  });
  emit(ctrl, "response.web_search_call.searching", {
    type: "response.web_search_call.searching",
    item_id: toolCallId,
    output_index: outputIndex,
    sequence_number: seq(),
  });
}

function emitToolCallCompleted(
  ctrl: ReadableStreamDefaultController,
  toolCallId: string,
  outputIndex: number,
  query: string | undefined,
  seq: () => number,
) {
  const completedItem: WebSearchCallOutputItem = {
    id: toolCallId, type: "web_search_call", status: "completed",
    action: { type: "search", query: query ?? "" },
  };

  emit(ctrl, "response.web_search_call.done", {
    type: "response.web_search_call.done",
    item_id: toolCallId,
    output_index: outputIndex,
    item: completedItem,
    sequence_number: seq(),
  });
  emit(ctrl, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: completedItem,
    sequence_number: seq(),
  });
}

/** Emits the full event sequence for a function tool call (added → args delta → args done → item done). */
function emitFunctionCallEvents(
  ctrl: ReadableStreamDefaultController,
  item: FunctionCallOutputItem,
  outputIndex: number,
  seq: () => number,
) {
  emit(ctrl, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { ...item, status: "in_progress", arguments: "" },
    sequence_number: seq(),
  });
  emit(ctrl, "response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    item_id: item.id,
    output_index: outputIndex,
    delta: item.arguments,
    sequence_number: seq(),
  });
  emit(ctrl, "response.function_call_arguments.done", {
    type: "response.function_call_arguments.done",
    item_id: item.id,
    output_index: outputIndex,
    arguments: item.arguments,
    sequence_number: seq(),
  });
  emit(ctrl, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item,
    sequence_number: seq(),
  });
}

/** Emits the closing sequence: text done -> annotation(s) -> content part done -> output item done. */
function emitMessageFinished(
  ctrl: ReadableStreamDefaultController,
  messageItemId: string,
  outputIndex: number,
  text: string,
  annotations: OutputTextContentPart["annotations"],
  seq: () => number,
) {
  emit(ctrl, "response.output_text.done", {
    type: "response.output_text.done",
    item_id: messageItemId,
    output_index: outputIndex,
    content_index: 0,
    text,
    sequence_number: seq(),
  });

  for (let i = 0; i < annotations.length; i++) {
    emit(ctrl, "response.output_text.annotation.added", {
      type: "response.output_text.annotation.added",
      item_id: messageItemId,
      output_index: outputIndex,
      content_index: 0,
      annotation: annotations[i],
      annotation_index: i,
      sequence_number: seq(),
    });
  }

  const completedPart: OutputTextContentPart = { type: "output_text", text, annotations, logprobs: null };

  emit(ctrl, "response.content_part.done", {
    type: "response.content_part.done",
    item_id: messageItemId,
    output_index: outputIndex,
    content_index: 0,
    part: completedPart,
    sequence_number: seq(),
  });

  const completedMessage: MessageOutputItem = {
    id: messageItemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [completedPart],
  };

  emit(ctrl, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: completedMessage,
    sequence_number: seq(),
  });
}

function emitResponseCompleted(
  ctrl: ReadableStreamDefaultController,
  response: ResponseObject,
  seq: () => number,
) {
  emit(ctrl, "response.completed", {
    type: "response.completed",
    response,
    sequence_number: seq(),
  });
}

function emitStreamError(
  ctrl: ReadableStreamDefaultController,
  message: string,
  seq: () => number,
) {
  emit(ctrl, "error", {
    type: "error",
    code: "server_error",
    message,
    sequence_number: seq(),
  });
}

function emitResponseFailed(
  ctrl: ReadableStreamDefaultController,
  response: ResponseObject,
  seq: () => number,
) {
  emit(ctrl, "response.failed", {
    type: "response.failed",
    response,
    sequence_number: seq(),
  });
}
