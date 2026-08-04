/** Runs a response generation to completion and records it, for every mode but streaming. */
import { generateText } from "ai";
import type { ApiCallInputMessage } from "common-db";
import type { AuthResult } from "../auth";
import { getResponse, saveResponse, type ResponseCreation } from "../response-store";
import { logChatUsage, isUpstreamError, clientFacingErrorMessage } from "../util";
import { rootLogger } from "../../logger";
import type { CreateResponseBody, OutputItem, ResponseObject } from "./schemas";
import { createToolTracker, type ToolCallItem, type ToolResultData } from "./tools";
import { buildOutputItems, buildStepOutputItems, extractSearchAnnotations, type IncludeValue } from "./items";
import { createResponseObject, formatUsage, markResponseFailed } from "./response-object";
import { buildGenerationParams, buildOutputConfig, resolveResponseText } from "./generation-params";

const log = rootLogger.child({ name: "response-generate" });

async function checkCancelled(orgId: string, responseId: string): Promise<boolean> {
  const stored = await getResponse(orgId, responseId) as { status?: string } | null;
  return stored?.status === "cancelled";
}

export async function createAndSaveInProgressResponse(
  orgId: string,
  responseId: string,
  createdAt: number,
  originalModel: string,
  body: CreateResponseBody,
  creation: ResponseCreation,
) {
  const baseResponse = createResponseObject({
    responseId, createdAt, model: originalModel, status: "in_progress", body,
  });
  await saveResponse(orgId, responseId, baseResponse, creation);
  return baseResponse;
}

/** Settles the row a failed run would otherwise leave sitting at in_progress. */
export async function saveFailedResponse(
  orgId: string,
  responseId: string,
  createdAt: number,
  originalModel: string,
  body: CreateResponseBody,
  error: unknown,
): Promise<void> {
  const failedResponse = markResponseFailed(
    createResponseObject({ responseId, createdAt, model: originalModel, status: "failed", body }),
    clientFacingErrorMessage(error),
  );
  await saveResponse(orgId, responseId, failedResponse)
    .catch((err) => log.error({ err, responseId }, "Failed to persist failed response"));
}

type LogFields = {
  readonly auth: AuthResult;
  readonly modelInfo: { model: string };
  readonly publicSpecifier: string;
  readonly inputMessages: ApiCallInputMessage[];
  readonly callStartTime: number;
  readonly logCalls: boolean | undefined;
  readonly metadata: Record<string, unknown> | undefined;
};

export type GeneratePersistArgs = {
  orgId: string;
  responseId: string;
  createdAt: number;
  originalModel: string;
  body: CreateResponseBody;
  genParams: Omit<ReturnType<typeof buildGenerationParams>, "stopWhen"> & Pick<Parameters<typeof generateText>[0], "prepareStep" | "stopWhen">;
  include: IncludeValue[];
  outputConfig: ReturnType<typeof buildOutputConfig>;
  logFields: LogFields;
  deepResearch?: {
    compactionUsage: { inputTokens: number; outputTokens: number };
  };
};

function createWriteQueue(onError: (err: unknown) => void) {
  let tail = Promise.resolve();
  return {
    enqueue(write: () => Promise<void>) {
      tail = tail.then(write).catch(onError);
    },
    flush() {
      return tail;
    },
  };
}

export async function generateAndPersistCompletedResponse(args: GeneratePersistArgs, background = false) {
  const { orgId, responseId, createdAt, originalModel, body, genParams, include, outputConfig, logFields, deepResearch } = args;
  const toolCalls: ToolCallItem[] = [];
  const toolResults: ToolResultData[] = [];

  const cancelCheck = () => checkCancelled(orgId, responseId);
  const existingStop = genParams.stopWhen;
  const priorConditions = Array.isArray(existingStop) ? existingStop : existingStop ? [existingStop] : [];
  const stopConditions = background
    ? [...priorConditions, cancelCheck]
    : existingStop;

  const progressItems: OutputItem[] = [];
  const progressWrites = createWriteQueue((err) => {
    log.warn({ err, responseId }, "Failed to persist research progress");
  });
  const stepUsage = { inputTokens: 0, outputTokens: 0 };

  type StepEvent = {
    toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
    toolResults?: Array<Record<string, unknown>>;
    usage?: { inputTokens?: number; outputTokens?: number };
  };

  const onStepFinish: (event: StepEvent) => void = deepResearch
    ? (step) => {
        stepUsage.inputTokens += step.usage?.inputTokens ?? 0;
        stepUsage.outputTokens += step.usage?.outputTokens ?? 0;

        if (step.toolResults) {
          for (const tr of step.toolResults) {
            const id = tr.toolCallId;
            const name = tr.toolName;
            if (typeof id === "string" && typeof name === "string") {
              toolResults.push({ toolCallId: id, toolName: name, args: tr.input, result: tr.output });
            }
          }
        }

        const newItems = buildStepOutputItems(step.toolCalls, step.toolResults, include);
        if (newItems.length === 0) return;
        progressItems.push(...newItems);

        const totalUsage = {
          inputTokens: stepUsage.inputTokens + deepResearch.compactionUsage.inputTokens,
          outputTokens: stepUsage.outputTokens + deepResearch.compactionUsage.outputTokens,
        };
        const snapshot = [...progressItems];
        progressWrites.enqueue(async () => {
          const stored = await getResponse(orgId, responseId) as ResponseObject | null;
          if (!stored || stored.status === "cancelled") return;
          stored.output = snapshot;
          stored.usage = formatUsage(totalUsage);
          await saveResponse(orgId, responseId, stored);
        });
      }
    : createToolTracker(toolCalls, toolResults);

  const result = await generateText({
    ...genParams,
    stopWhen: stopConditions as Parameters<typeof generateText>[0]["stopWhen"],
    onStepFinish,
  });

  if (background && await checkCancelled(orgId, responseId)) {
    return;
  }

  await progressWrites.flush();

  const responseText = resolveResponseText(result.text, () => result.output, outputConfig.usesStructuredOutput);

  const finalUsage = deepResearch
    ? {
        inputTokens: (result.usage.inputTokens ?? 0) + deepResearch.compactionUsage.inputTokens,
        outputTokens: (result.usage.outputTokens ?? 0) + deepResearch.compactionUsage.outputTokens,
      }
    : result.usage;

  let finalOutput: OutputItem[];
  if (deepResearch) {
    const annotations = extractSearchAnnotations(toolResults);
    progressItems.push({
      id: `msg_${responseId}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: responseText, annotations, logprobs: null }],
    });
    finalOutput = progressItems;
  } else {
    finalOutput = buildOutputItems(responseId, responseText, toolCalls, toolResults, include, result.reasoning.map(part => part.text));
  }

  const completedResponse = createResponseObject({
    responseId, createdAt, model: originalModel, status: "completed",
    output: finalOutput, usage: finalUsage, body,
  });
  await saveResponse(orgId, responseId, completedResponse);
  logChatUsage({
    ...logFields,
    usage: finalUsage,
    outputData: { model: originalModel, choices: [{ index: 0, message: { role: "assistant", content: responseText } }] },
    stream: false,
  });
  return completedResponse;
}

export async function runBackground(args: GeneratePersistArgs) {
  const { orgId, responseId, createdAt, originalModel, body } = args;
  try {
    await generateAndPersistCompletedResponse(args, true);
  } catch (error) {
    if (!isUpstreamError(error)) {
      log.error({ err: error, responseId }, "Background response generation failed");
    }
    await saveFailedResponse(orgId, responseId, createdAt, originalModel, body, error);
  }
}
