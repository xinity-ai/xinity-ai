import { logChatSync, logChatStream, type ChatSyncData, type ChatStreamData } from "../callLogger";
import { recordTokenUsage, recordModelRequest } from "../metrics";
import { recordUsageEvent } from "../usageRecorder";
import type { AuthResult } from "./auth";
import type { ApiCallInputMessage, InferenceEndpoint } from "common-db";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "usage" });

export type UsageData = {
  inputTokens?: number;
  outputTokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

function normalizeInputTokens(usage: UsageData): number {
  return usage.inputTokens ?? usage.prompt_tokens ?? 0;
}

function normalizeOutputTokens(usage: UsageData): number {
  return usage.outputTokens ?? usage.completion_tokens ?? 0;
}

export type RecordUsageContext = {
  usage: UsageData | null | undefined;
  auth: AuthResult;
  modelInfo: { model: string; nodeId?: string | null };
  callStartTime: number;
  logCalls?: boolean;
  deployment?: string;
};

export const recordUsage = ({
  usage,
  auth,
  modelInfo,
  callStartTime,
  logCalls,
  deployment,
}: RecordUsageContext): boolean => {
  const durationMs = Date.now() - callStartTime;
  recordTokenUsage(modelInfo.model, auth.keyId, auth.orgId, usage, { deployment, durationMs });
  recordModelRequest(modelInfo.model, true, auth.orgId);
  if (!usage) {
    return false;
  }

  const shouldLog = logCalls ?? auth.collectData;

  recordUsageEvent({
    organizationId: auth.orgId,
    applicationId: auth.applicationId,
    apiKeyId: auth.keyId,
    model: modelInfo.model,
    inputTokens: normalizeInputTokens(usage),
    outputTokens: normalizeOutputTokens(usage),
    duration: durationMs,
    logged: shouldLog,
    nodeId: modelInfo.nodeId ?? null,
    success: true,
  });

  return shouldLog;
};

export type FailedRequestContext = {
  auth: AuthResult;
  modelInfo: { model: string; nodeId?: string | null };
  callStartTime: number;
};

export function recordFailedRequest({ auth, modelInfo, callStartTime }: FailedRequestContext): void {
  recordModelRequest(modelInfo.model, false, auth.orgId);
  recordUsageEvent({
    organizationId: auth.orgId,
    applicationId: auth.applicationId,
    apiKeyId: auth.keyId,
    model: modelInfo.model,
    inputTokens: 0,
    outputTokens: 0,
    duration: Date.now() - callStartTime,
    logged: false,
    nodeId: modelInfo.nodeId ?? null,
    success: false,
  });
}

type UsageLogContextBase = {
  usage: UsageData | null | undefined;
  auth: AuthResult;
  modelInfo: { model: string };
  endpoint: InferenceEndpoint;
  publicSpecifier: string;
  inputMessages: ApiCallInputMessage[];
  callStartTime: number;
  logCalls?: boolean;
  metadata?: Record<string, unknown>;
};

export type UsageLogContext = UsageLogContextBase & (
  | { stream: true; outputData: ChatStreamData }
  | { stream: false; outputData: ChatSyncData }
);

export const logChatUsage = ({
  usage,
  outputData,
  stream,
  auth,
  modelInfo,
  publicSpecifier,
  endpoint,
  inputMessages,
  callStartTime,
  logCalls,
  metadata,
}: UsageLogContext) => {
  const shouldLog = recordUsage({ usage, auth, modelInfo, callStartTime, logCalls, deployment: publicSpecifier });
  if (!shouldLog) {
    return;
  }

  const commonFields = {
    keyId: auth.keyId,
    applicationId: auth.applicationId,
    organizationId: auth.orgId,
    publicSpecifier,
    engineModel: modelInfo.model,
    endpoint,
    durationInMS: Date.now() - callStartTime,
    inputMessages,
    metadata,
  };

  if (stream) {
    logChatStream({ ...commonFields, data: outputData }).catch((err) => {
      log.error({ err }, "logChatStream error");
    });
  } else {
    logChatSync({ ...commonFields, data: outputData }).catch((err) => {
      log.error({ err }, "logChatSync error");
    });
  }
};
