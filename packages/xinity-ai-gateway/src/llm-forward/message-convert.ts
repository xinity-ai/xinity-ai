import type { ModelMessage, FilePart, ImagePart, TextPart } from "ai";
import type { ApiCallInputMessage, ApiCallInputMessageContent } from "common-db";
import { STORABLE_AUDIO_TYPES } from "common-env/media-types";

export function toModelMessages(messages: ApiCallInputMessage[]): ModelMessage[] {
  const toolCallNameMap = new Map<string, string>();
  for (const msg of messages) {
    const raw = msg as Record<string, unknown>;
    if (raw.role === "assistant" && Array.isArray(raw.tool_calls)) {
      for (const tc of raw.tool_calls as Array<{ id?: string; function?: { name?: string } }>) {
        if (tc.id && tc.function?.name) toolCallNameMap.set(tc.id, tc.function.name);
      }
    }
  }

  return messages.map((msg) => {
    const raw = msg as Record<string, unknown>;

    if (raw.role === "assistant" && Array.isArray(raw.tool_calls)) {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof raw.content === "string" && raw.content) {
        parts.push({ type: "text", text: raw.content });
      }
      for (const tc of raw.tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }>) {
        if (tc.type !== "function") continue;
        let args: unknown;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        parts.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: args,
        });
      }
      return { role: "assistant", content: parts } as unknown as ModelMessage;
    }

    if (raw.role === "tool" && typeof raw.tool_call_id === "string") {
      const resultValue = typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content);
      return {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: raw.tool_call_id,
          toolName: toolCallNameMap.get(raw.tool_call_id as string) ?? "",
          output: { type: "text", value: resultValue },
        }],
      } as unknown as ModelMessage;
    }

    if (msg.role === "system" || msg.role === "developer") {
      return toInstructionMessage(msg.role, msg.content);
    }

    if (typeof msg.content === "string" || !Array.isArray(msg.content)) {
      return msg as ModelMessage;
    }
    return { ...msg, content: msg.content.map(toModelPart) } as ModelMessage;
  });
}

// The AI SDK has no developer role, so the provider is told to write this system message out as one.
function toInstructionMessage(role: "system" | "developer", content: ApiCallInputMessage["content"]): ModelMessage {
  const text = typeof content === "string" ? content : (content ?? []).map((part) => {
    if (part.type !== "text") {
      throw new Error(`${role} messages can only carry text, got ${part.type}`);
    }
    return part.text;
  }).join("\n");
  return role === "developer"
    ? { role: "system", content: text, providerOptions: { openaiCompatible: { role: "developer" } } }
    : { role: "system", content: text };
}

function toModelPart(part: ApiCallInputMessageContent): TextPart | ImagePart | FilePart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image_url":
      return { type: "image", image: part.image_url.url };
    case "input_audio":
      return { type: "file", mediaType: STORABLE_AUDIO_TYPES[part.input_audio.format], data: part.input_audio.data };
    default: {
      const unhandled: never = part;
      throw new Error(`Unhandled content part type: ${(unhandled as { type: unknown }).type}`);
    }
  }
}
