import { z } from "zod";
import { errorResponse } from "../util";
import { withEndpointGuards } from "../endpoint-guards";
import { BackendCompletionChunkSchema } from "../backend-schemas";
import type { ApiCallInputMessage } from "common-db";
import { rootLogger } from "../../logger";
import { backendPostJson } from "../backend-fetch";
import {
  forwardOpenAIResponse,
  type NonStreamSpec,
  type StreamSpec,
} from "../openai-forward";

const log = rootLogger.child({ name: "handle-completions" });

export const CompletionBodySchema = z.looseObject({
  model: z.string(),
  prompt: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  stream: z.boolean().optional().default(false),
  seed: z.number().optional(),
  logprobs: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  store: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

function normalizePrompt(prompt: string | string[] | undefined): string | null {
  if (typeof prompt === "string") {
    return prompt;
  }
  if (Array.isArray(prompt)) {
    return prompt.join("\n");
  }
  return null;
}

type CompletionAcc = {
  content: string;
  finish_reason?: string | null;
};

const completionStreamSpec: StreamSpec<z.infer<typeof BackendCompletionChunkSchema>, CompletionAcc> = {
  chunkSchema: BackendCompletionChunkSchema,
  initAcc: () => ({ content: "" }),
  applyChoice: (acc, choice) => {
    acc.content += choice.text ?? "";
    if (choice.finish_reason) {
      acc.finish_reason = choice.finish_reason;
    }
  },
  toLogEntry: (acc, index, model) => ({
    model,
    choices: [{
      index,
      delta: { role: "assistant", content: acc.content },
      finish_reason: acc.finish_reason ?? null,
    }],
  }),
};

export const CompletionSyncChoiceSchema = z.looseObject({
  index: z.number(),
  text: z.string(),
  finish_reason: z.string().nullable().optional(),
});

const completionNonStreamSpec: NonStreamSpec<z.infer<typeof CompletionSyncChoiceSchema>> = {
  choicesSchema: z.array(CompletionSyncChoiceSchema),
  toLogOutput: (choices, model) => ({
    model,
    choices: choices.map((ch) => ({
      index: ch.index,
      message: { role: "assistant", content: ch.text },
    })),
  }),
};

export const handleCompletion = withEndpointGuards({
  modelTypes: ["chat"],
  bodySchema: CompletionBodySchema,
  log,
  method: "POST",
  handler: async ({ auth, body, modelInfo, originalModel, req }) => {
    const promptText = normalizePrompt(body.prompt);
    if (!promptText) {
      return errorResponse("Missing or empty 'prompt' field", 400);
    }

    const callStartTime = Date.now();

    const inputMessages: ApiCallInputMessage[] = [{ role: "user", content: promptText }];
    const logFields = {
      auth,
      modelInfo,
      modelSpecifier: originalModel,
      inputMessages,
      callStartTime,
      logCalls: body.store,
      metadata: body.metadata ?? undefined,
    };

    const fetchBody: Record<string, unknown> = {
      model: modelInfo.model,
      prompt: promptText,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      frequency_penalty: body.frequency_penalty,
      presence_penalty: body.presence_penalty,
      seed: body.seed,
      logprobs: body.logprobs,
      stop: body.stop,
      stream: body.stream,
    };
    if (body.stream) {
      fetchBody.stream_options = { include_usage: true };
    }

    const backendResponse = await backendPostJson(modelInfo, "/v1/completions", fetchBody, req.signal);

    return forwardOpenAIResponse({
      backendResponse,
      originalModel,
      stream: body.stream,
      streamSpec: completionStreamSpec,
      nonStreamSpec: completionNonStreamSpec,
      logFields,
      log,
    });
  },
});
