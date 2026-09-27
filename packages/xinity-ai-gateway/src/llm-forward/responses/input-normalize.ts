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

type TextMessageRole = "user" | "assistant" | "system" | "developer";
const VALID_TEXT_ROLES = new Set<TextMessageRole>(["user", "assistant", "system", "developer"]);

function normalizeRole(raw: unknown): TextMessageRole {
  if (typeof raw === "string" && VALID_TEXT_ROLES.has(raw as TextMessageRole)) return raw as TextMessageRole;
  return "user";
}

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type Refusal = { refusal: string };

function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && "refusal" in value;
}

const PART_TYPES: Record<TextMessageRole, readonly string[]> = {
  user: ["input_text", "input_image"],
  assistant: ["input_text", "output_text", "refusal"],
  system: ["input_text"],
  developer: ["input_text"],
};

function convertPart(part: unknown, role: TextMessageRole, at: string): ContentPart | Refusal {
  if (typeof part !== "object" || part === null) {
    return { refusal: `${at} is ${part === null ? "null" : typeof part}, expected a content part object` };
  }
  const p = part as Record<string, unknown>;
  if (p.type === "input_file") {
    return { refusal: `${at}: input_file parts are not supported by the inference backends` };
  }
  if (p.type === "input_audio") {
    return { refusal: `${at}: input_audio is not supported by /v1/responses. Send audio to /v1/chat/completions instead` };
  }
  const allowed = PART_TYPES[role];
  if (typeof p.type !== "string" || !allowed.includes(p.type)) {
    return { refusal: `${at}: ${String(p.type)} is not allowed in ${role} messages. Allowed: ${allowed.join(", ")}` };
  }
  if (p.type === "input_image") {
    return typeof p.image_url === "string"
      ? { type: "image_url", image_url: { url: p.image_url } }
      : { refusal: `${at}: input_image requires an image_url string. file_id is not supported` };
  }
  const text = p.type === "refusal" ? p.refusal : p.text;
  return typeof text === "string"
    ? { type: "text", text }
    : { refusal: `${at}: ${p.type} requires a ${p.type === "refusal" ? "refusal" : "text"} string` };
}

function extractContent(raw: unknown, role: TextMessageRole, at: string): ApiCallInputMessage["content"] | Refusal {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts: ContentPart[] = [];
    for (const [index, part] of raw.entries()) {
      const converted = convertPart(part, role, `${at}.content[${index}]`);
      if (isRefusal(converted)) {
        return converted;
      }
      parts.push(converted);
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
    for (const [index, item] of input.entries()) {
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
      const content = extractContent(obj.content ?? obj.input ?? obj.text, role, `input[${index}]`);
      if (!content) return null;
      if (isRefusal(content)) return content;
      messages.push({ role, content } as ApiCallInputMessage);
    }
    return { messages };
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const role = normalizeRole(obj.role);
    const content = extractContent(obj.content ?? obj.input ?? obj.text, role, "input");
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
