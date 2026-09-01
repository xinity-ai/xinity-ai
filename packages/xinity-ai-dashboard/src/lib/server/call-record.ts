/**
 * The single call shape readers hand out. Rows still in the legacy `api_call` table are normalized
 * into it, so no consumer has to know which table a call came from and the shape survives that
 * table being dropped.
 */
import type { apiCallT, ApiCallInputMessage, InferenceCall, InferenceEndpoint } from "common-db";
import type { CallMessages } from "./call-messages";

export type CallRecord = {
  id: string;
  organizationId: string;
  apiKeyId: string | null;
  applicationId: string | null;
  createdAt: Date;
  endpoint: InferenceEndpoint;
  servedModel: string;
  publicSpecifier: string;
  user: string | null;
  durationMs: number;
  metadata: Record<string, unknown>;
  inputMessages: ApiCallInputMessage[];
  outputMessages: ApiCallInputMessage[];
};

export function inferenceToCallRecord(
  call: InferenceCall,
  messages: CallMessages | undefined,
): CallRecord {
  return {
    id: call.id,
    organizationId: call.organizationId,
    apiKeyId: call.apiKeyId,
    applicationId: call.applicationId,
    createdAt: call.createdAt,
    endpoint: call.endpoint,
    servedModel: call.servedModel,
    publicSpecifier: call.publicSpecifier,
    user: call.user,
    durationMs: call.durationMs,
    metadata: call.metadata,
    inputMessages: messages?.inputMessages ?? [],
    outputMessages: messages?.outputMessage ? [messages.outputMessage] : [],
  };
}

/** Legacy rows predate the endpoint column, and only the chat surface ever wrote them. */
export function legacyToCallRecord(call: typeof apiCallT.$inferSelect): CallRecord {
  return {
    id: call.id,
    organizationId: call.organizationId,
    apiKeyId: call.apiKeyId,
    applicationId: call.applicationId,
    createdAt: call.createdAt,
    endpoint: "chat_completions",
    servedModel: call.model,
    publicSpecifier: call.specifiedModel ?? call.model,
    user: call.user,
    durationMs: call.duration ?? 0,
    metadata: call.metadata ?? {},
    inputMessages: call.inputMessages,
    outputMessages: call.outputMessage ? [call.outputMessage] : [],
  };
}
