/** Normalises the several input shapes `/v1/responses` accepts into chat messages. */
import type { ApiCallInputMessage } from "common-db";

export function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        const p = part as Record<string, unknown> | null;
        if (p && typeof p.text === "string") return p.text;
        if (p && typeof p.content === "string") return p.content;
        return null;
      })
      .filter(Boolean);
    return parts.length ? parts.join("") : null;
  }
  const c = content as Record<string, unknown> | null;
  if (c && typeof c.text === "string") return c.text;
  return null;
}

type TextMessageRole = "user" | "assistant" | "system";
const VALID_TEXT_ROLES = new Set<TextMessageRole>(["user", "assistant", "system"]);

function normalizeRole(raw: unknown): TextMessageRole {
  if (typeof raw === "string" && VALID_TEXT_ROLES.has(raw as TextMessageRole)) return raw as TextMessageRole;
  return "user";
}

/** Extract content parts, preserving image_url entries alongside text. */
function extractContent(raw: unknown): string | ApiCallInputMessage["content"] | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
    for (const part of raw) {
      if (typeof part === "string") {
        parts.push({ type: "text", text: part });
        continue;
      }
      const p = part as Record<string, unknown> | null;
      if (!p) continue;
      if (p.type === "image_url" && p.image_url && typeof (p.image_url as Record<string, unknown>).url === "string") {
        parts.push({ type: "image_url", image_url: { url: (p.image_url as { url: string }).url } });
        continue;
      }
      if (typeof p.text === "string") parts.push({ type: "text", text: p.text });
      else if (typeof p.content === "string") parts.push({ type: "text", text: p.content });
    }
    if (!parts.length) return null;
    const [first] = parts;
    if (parts.length === 1 && first?.type === "text") return first.text;
    return parts;
  }
  return extractText(raw);
}

export function normalizeMessages(input: unknown): ApiCallInputMessage[] | null {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) {
    if (input.every((item) => typeof item === "string"))
      return input.map((text) => ({ role: "user", content: text }));
    const messages: ApiCallInputMessage[] = [];
    for (const item of input) {
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;

      // Handle function_call_output items (client returning function tool results)
      if (obj.type === "function_call_output") {
        const output = typeof obj.output === "string" ? obj.output : JSON.stringify(obj.output ?? "");
        messages.push({
          role: "tool",
          content: output,
          tool_call_id: obj.call_id as string,
        } as ApiCallInputMessage);
        continue;
      }

      const role = normalizeRole(obj.role);
      const content = extractContent(obj.content ?? obj.input ?? obj.text);
      if (!content) return null;
      messages.push({ role, content } as ApiCallInputMessage);
    }
    return messages;
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const role = normalizeRole(obj.role);
    const content = extractContent(obj.content ?? obj.input ?? obj.text);
    if (!content) return null;
    return [{ role, content } as ApiCallInputMessage];
  }
  return null;
}

export type StoredResponse = {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
    // function_call fields
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
};

export function outputAsMessages(stored: StoredResponse): ApiCallInputMessage[] {
  const messages: ApiCallInputMessage[] = [];
  // Collect function_call items to inject as a single assistant tool_calls message
  const functionCalls: Array<{ call_id: string; name: string; arguments: string }> = [];

  for (const item of stored.output ?? []) {
    if (item.type === "message") {
      const textParts = (item.content ?? [])
        .filter((c) => c.type === "output_text" && typeof c.text === "string")
        .map((c) => c.text as string);
      if (textParts.length) messages.push({ role: "assistant", content: textParts.join("") });
    } else if (item.type === "function_call" && item.call_id && item.name) {
      functionCalls.push({
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments ?? "{}",
      });
    }
  }

  // Re-inject function calls as an assistant tool_calls message so the AI SDK
  // can continue the conversation when the client sends function_call_output
  if (functionCalls.length) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: functionCalls.map((fc) => ({
        id: fc.call_id,
        type: "function" as const,
        function: { name: fc.name, arguments: fc.arguments },
      })),
    } as ApiCallInputMessage);
  }

  return messages;
}
