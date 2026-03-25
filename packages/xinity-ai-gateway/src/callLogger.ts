import { getDB } from "./db";
import { apiCallT, type ApiCallInputMessage } from "common-db";
import { range } from "rambda";
import { rootLogger } from "./logger";

const log = rootLogger.child({ name: "call-logger" });

export type ChatSyncData = {
  model: string;
  choices: Array<{
    index: number;
    message: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
};

export type ChatStreamData = Array<{
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
}>;

type ChatLogFields = {
  keyId: string;
  applicationId: string | null;
  organizationId: string;
  durationInMS: number;
  modelSpecifier: string;
  inputMessages: ApiCallInputMessage[];
  metadata?: Record<string, unknown>;
};

type ChatSyncInput = ChatLogFields & { data: ChatSyncData };
type ChatStreamInput = ChatLogFields & { data: ChatStreamData };

export async function logChatSync(input: ChatSyncInput) {
  if (!input.data.choices.length) return;
  const rows = input.data.choices.map((choice) => {
    const msg = choice.message;
    const outputMessage: ApiCallInputMessage = {
      role: ((msg.role as string) || "assistant") as ApiCallInputMessage["role"],
      content: (msg.content as string | null) ?? "",
    };
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      outputMessage.tool_calls = msg.tool_calls as ApiCallInputMessage["tool_calls"];
    }
    return {
      apiKeyId: input.keyId,
      applicationId: input.applicationId,
      organizationId: input.organizationId,
      specifiedModel: input.modelSpecifier,
      duration: input.durationInMS,
      model: input.data.model,
      outputMessage,
      inputMessages: input.inputMessages,
      metadata: input.metadata,
    };
  });
  await getDB().insert(apiCallT).values(rows).catch((x) => {
    log.error({ err: x }, "DB error writing API call");
  });
}

export async function logChatStream(input: ChatStreamInput) {
  if (!input.data.length || !input.data[0]!.choices.length) return;

  const messageModel = input.data[0]!.model;
  const choiceCount = input.data[0]!.choices.length;
  const rows = range(0)(choiceCount).map((choiceIndex) => {
    const fullMessage = input.data
      .map((x) => x.choices[choiceIndex]?.delta.content as string | undefined)
      .filter((x) => x)
      .join("");
    const role = ((input.data[0]!.choices[choiceIndex]?.delta.role as string) || "assistant") as ApiCallInputMessage["role"];
    const outputMessage: ApiCallInputMessage = { content: fullMessage, role };
    // Preserve tool_calls from the final delta (set by onFinish)
    const toolCalls = input.data
      .map((x) => x.choices[choiceIndex]?.delta.tool_calls)
      .find((tc) => Array.isArray(tc) && tc.length > 0);
    if (toolCalls) {
      outputMessage.tool_calls = toolCalls as ApiCallInputMessage["tool_calls"];
    }
    return {
      apiKeyId: input.keyId,
      applicationId: input.applicationId,
      organizationId: input.organizationId,
      specifiedModel: input.modelSpecifier,
      duration: input.durationInMS,
      model: messageModel,
      outputMessage,
      inputMessages: input.inputMessages,
      metadata: input.metadata,
    };
  });
  await getDB().insert(apiCallT).values(rows).catch((x) => {
    log.error({ err: x }, "DB error writing API call");
  });
}
