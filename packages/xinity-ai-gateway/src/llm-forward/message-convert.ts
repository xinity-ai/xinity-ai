import type { ModelMessage, ImagePart, TextPart } from "ai";
import type { ApiCallInputMessage } from "common-db";

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

    if (typeof msg.content === "string" || !Array.isArray(msg.content)) {
      return msg as ModelMessage;
    }
    const content = (msg.content as Array<{ type: string; text?: string; image_url?: { url: string } }>).flatMap<TextPart | ImagePart>((part) => {
      if (part.type !== "image_url" || !part.image_url) {
        return [part as TextPart];
      }
      return [{ type: "image", image: part.image_url.url }];
    });
    return { ...msg, content } as ModelMessage;
  });
}
