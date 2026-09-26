/** Normalises the several input shapes `/v1/responses` accepts into chat messages. */
import type { ApiCallInputMessage } from "common-db";
import type { OutputItem } from "./schemas";

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

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type Refusal = { refusal: string };

function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && "refusal" in value;
}

/** One input part as chat content: kept, refused with a reason, or null when it carries nothing to keep. */
function convertPart(part: unknown): ContentPart | Refusal | null {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }
  const p = part as Record<string, unknown> | null;
  if (!p || typeof p !== "object") {
    return null;
  }
  switch (p.type) {
    case "input_image":
      return typeof p.image_url === "string"
        ? { type: "image_url", image_url: { url: p.image_url } }
        : { refusal: "input_image requires an image_url string. file_id is not supported" };
    case "image_url": {
      const url = (p.image_url as Record<string, unknown> | null | undefined)?.url;
      if (typeof url === "string") {
        return { type: "image_url", image_url: { url } };
      }
      break;
    }
    // OpenAI's Responses API takes no audio input.
    case "input_audio":
      return { refusal: "input_audio is not supported by /v1/responses. Send audio to /v1/chat/completions instead" };
  }
  if (typeof p.text === "string") {
    return { type: "text", text: p.text };
  }
  if (typeof p.content === "string") {
    return { type: "text", text: p.content };
  }
  return null;
}

function extractContent(raw: unknown): ApiCallInputMessage["content"] | Refusal {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts: ContentPart[] = [];
    for (const converted of raw.map(convertPart)) {
      if (isRefusal(converted)) {
        return converted;
      }
      if (converted) {
        parts.push(converted);
      }
    }
    if (!parts.length) return null;
    const [first] = parts;
    if (parts.length === 1 && first?.type === "text") return first.text;
    return parts;
  }
  return extractText(raw);
}

/** Null when the input has no shape this endpoint understands. */
export function normalizeMessages(input: unknown): { messages: ApiCallInputMessage[] } | Refusal | null {
  if (typeof input === "string") return { messages: [{ role: "user", content: input }] };
  if (Array.isArray(input)) {
    if (input.every((item) => typeof item === "string"))
      return { messages: input.map((text) => ({ role: "user", content: text })) };
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
      if (isRefusal(content)) return content;
      messages.push({ role, content } as ApiCallInputMessage);
    }
    return { messages };
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const role = normalizeRole(obj.role);
    const content = extractContent(obj.content ?? obj.input ?? obj.text);
    if (!content) return null;
    if (isRefusal(content)) return content;
    return { messages: [{ role, content } as ApiCallInputMessage] };
  }
  return null;
}

/** The chat form of a reply, which is what a later turn replays. Item types with no chat
 * representation, web search among them, have none and are left to the output items. */
export function outputAsMessages(response: { output: OutputItem[] }): ApiCallInputMessage[] {
  const messages: ApiCallInputMessage[] = [];
  // Collect function_call items to inject as a single assistant tool_calls message
  const functionCalls: Array<{ call_id: string; name: string; arguments: string }> = [];

  for (const item of response.output) {
    if (item.type === "message") {
      const textParts = item.content
        .filter((part) => part.type === "output_text")
        .map((part) => part.text);
      if (textParts.length) messages.push({ role: "assistant", content: textParts.join("") });
    } else if (item.type === "function_call") {
      functionCalls.push({
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
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
