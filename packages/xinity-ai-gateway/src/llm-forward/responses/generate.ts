/** Runs a response generation to completion and records it, for every mode but streaming. */
import { generateText } from "ai";
import type { CallLogFields } from "../usage";
import { getResponse, saveResponse, type ResponseCreation } from "../response-store";
import { logChatUsage, isUpstreamError, clientFacingErrorMessage } from "../util";
import { rootLogger } from "../../logger";
import type { CreateResponseBody, OutputItem, ResponseObject } from "./schemas";
import { createToolTracker, type ToolCallItem, type ToolResultData } from "./tools";
import { buildOutputItems, buildStepOutputItems, extractSearchAnnotations, type IncludeValue } from "./items";
import { createResponseObject, formatUsage, markResponseFailed } from "./response-object";
import { type buildGenerationParams, type buildOutputConfig, resolveResponseText } from "./generation-params";

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


export type GeneratePersistArgs = {
  orgId: string;
  responseId: string;
  createdAt: number;
  originalModel: string;
  body: CreateResponseBody;
  genParams: Omit<ReturnType<typeof buildGenerationParams>, "stopWhen"> & Pick<Parameters<typeof generateText>[0], "prepareStep" | "stopWhen">;
  include: IncludeValue[];
  outputConfig: ReturnType<typeof buildOutputConfig>;
  logFields: CallLogFields;
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

type StepEvent = {
  toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
  toolResults?: Array<Record<string, unknown>>;
  usage?: { inputTokens?: number; outputTokens?: number };
};

type StepUsage = { inputTokens?: number; outputTokens?: number };

/** Accumulates what a run produces. The two implementations are the only difference
 * between a deep research run and an ordinary one. */
type OutputCollector = {
  onStepFinish: (event: StepEvent) => void;
  flush: () => Promise<void>;
  totalUsage: (final: StepUsage) => StepUsage;
  buildOutput: (responseText: string, reasoningTexts: string[]) => OutputItem[];
};

function createPlainCollector(responseId: string, include: IncludeValue[]): OutputCollector {
  const toolCalls: ToolCallItem[] = [];
  const toolResults: ToolResultData[] = [];

  return {
    onStepFinish: createToolTracker(toolCalls, toolResults),
    flush: async () => {},
    totalUsage: (final) => final,
    buildOutput: (responseText, reasoningTexts) =>
      buildOutputItems(responseId, responseText, toolCalls, toolResults, include, reasoningTexts),
  };
}

/** Publishes partial output as it arrives, since a research run is too long to leave the
 * caller polling an empty response, and folds in the usage compaction spent along the way. */
function createResearchCollector(
  orgId: string,
  responseId: string,
  include: IncludeValue[],
  compactionUsage: { inputTokens: number; outputTokens: number },
): OutputCollector {
  const toolResults: ToolResultData[] = [];
  const progressItems: OutputItem[] = [];
  const stepUsage = { inputTokens: 0, outputTokens: 0 };
  const writes = createWriteQueue((err) => {
    log.warn({ err, responseId }, "Failed to persist research progress");
  });

  const withCompaction = (usage: StepUsage): StepUsage => ({
    inputTokens: (usage.inputTokens ?? 0) + compactionUsage.inputTokens,
    outputTokens: (usage.outputTokens ?? 0) + compactionUsage.outputTokens,
  });

  return {
    onStepFinish: (step) => {
      stepUsage.inputTokens += step.usage?.inputTokens ?? 0;
      stepUsage.outputTokens += step.usage?.outputTokens ?? 0;

      for (const tr of step.toolResults ?? []) {
        if (typeof tr.toolCallId === "string" && typeof tr.toolName === "string") {
          toolResults.push({ toolCallId: tr.toolCallId, toolName: tr.toolName, args: tr.input, result: tr.output });
        }
      }

      const newItems = buildStepOutputItems(step.toolCalls, step.toolResults, include);
      if (newItems.length === 0) {
        return;
      }
      progressItems.push(...newItems);

      const snapshot = [...progressItems];
      const usage = withCompaction(stepUsage);
      writes.enqueue(async () => {
        const stored = await getResponse(orgId, responseId) as ResponseObject | null;
        if (!stored || stored.status === "cancelled") {
          return;
        }
        stored.output = snapshot;
        stored.usage = formatUsage(usage);
        await saveResponse(orgId, responseId, stored);
      });
    },
    flush: writes.flush,
    totalUsage: withCompaction,
    buildOutput: (responseText) => [
      ...progressItems,
      {
        id: `msg_${responseId}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{
          type: "output_text",
          text: responseText,
          annotations: extractSearchAnnotations(toolResults),
          logprobs: null,
        }],
      },
    ],
  };
}

export async function generateAndPersistCompletedResponse(args: GeneratePersistArgs, background = false) {
  const { orgId, responseId, createdAt, originalModel, body, genParams, include, outputConfig, logFields, deepResearch } = args;

  const existingStop = genParams.stopWhen;
  const priorConditions = Array.isArray(existingStop) ? existingStop : existingStop ? [existingStop] : [];
  const stopConditions = background
    ? [...priorConditions, () => checkCancelled(orgId, responseId)]
    : existingStop;

  const collector = deepResearch
    ? createResearchCollector(orgId, responseId, include, deepResearch.compactionUsage)
    : createPlainCollector(responseId, include);

  const result = await generateText({
    ...genParams,
    stopWhen: stopConditions as Parameters<typeof generateText>[0]["stopWhen"],
    onStepFinish: collector.onStepFinish,
  });

  if (background && await checkCancelled(orgId, responseId)) {
    return;
  }

  await collector.flush();

  const responseText = resolveResponseText(result.text, () => result.output, outputConfig.usesStructuredOutput);
  const finalUsage = collector.totalUsage(result.usage);

  const completedResponse = createResponseObject({
    responseId, createdAt, model: originalModel, status: "completed",
    output: collector.buildOutput(responseText, result.reasoning.map((part) => part.text)), usage: finalUsage, body,
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
