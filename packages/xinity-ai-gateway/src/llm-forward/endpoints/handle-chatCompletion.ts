import { z } from "zod";
import {
  errorResponse,
  extractAllowedRequestParams,
  modelLacksToolSupport,
} from "../util";
import { withEndpointGuards } from "../endpoint-guards";
import { BackendChatChunkSchema } from "../backend-schemas";
import type { ApiCallInputMessage } from "common-db";
import { rootLogger } from "../../logger";
import { env } from "../../env";
import { processMessageImages, imageStore } from "../../image-store";
import { backendPostJson, createIdleTimeout } from "../backend-fetch";
import {
  forwardOpenAIResponse,
  type NonStreamSpec,
  type StreamSpec,
} from "../openai-forward";

const log = rootLogger.child({ name: "handle-chatCompletion" });

export const ChatCompletionBodySchema = z.looseObject({
  model: z.string(),
  messages: z.array(z.looseObject({
    role: z.string(),
    content: z.unknown(),
  })),
  stream: z.boolean().optional().default(false),
  store: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  top_p: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  seed: z.number().optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  response_format: z.object({
    type: z.enum(["text", "json_object", "json_schema"]),
    json_schema: z.object({
      name: z.string().optional(),
      schema: z.unknown().optional(),
    }).optional(),
  }).optional(),
  structured_outputs: z.record(z.string(), z.json().optional()).optional(),
  tools: z.array(z.looseObject({
    type: z.literal("function"),
    function: z.looseObject({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
      strict: z.boolean().optional(),
    }),
  })).optional(),
  tool_choice: z.union([
    z.enum(["auto", "none", "required"]),
    z.looseObject({
      type: z.literal("function"),
      function: z.looseObject({ name: z.string() }),
    }),
  ]).optional(),
});

type ToolCallAcc = {
  id?: string;
  type?: string;
  function: { name?: string; arguments: string };
};

type ChatAcc = {
  content: string;
  role: string;
  tool_calls?: ToolCallAcc[];
  finish_reason?: string | null;
};

const chatStreamSpec: StreamSpec<z.infer<typeof BackendChatChunkSchema>, ChatAcc> = {
  chunkSchema: BackendChatChunkSchema,
  initAcc: () => ({ content: "", role: "assistant" }),
  applyChoice: (acc, choice) => {
    if (typeof choice.delta.content === "string") {
      acc.content += choice.delta.content;
    }
    if (choice.delta.role) {
      acc.role = choice.delta.role;
    }
    if (Array.isArray(choice.delta.tool_calls)) {
      const calls = (acc.tool_calls ??= []);
      for (const fragment of choice.delta.tool_calls) {
        const existing = (calls[fragment.index] ??= { function: { arguments: "" } });
        if (fragment.id) existing.id = fragment.id;
        if (fragment.type) existing.type = fragment.type;
        if (fragment.function?.name) existing.function.name = fragment.function.name;
        if (typeof fragment.function?.arguments === "string") {
          existing.function.arguments += fragment.function.arguments;
        }
      }
    }
    if (choice.finish_reason) {
      acc.finish_reason = choice.finish_reason;
    }
  },
  toLogEntry: (acc, index, model) => ({
    model,
    choices: [{
      index,
      delta: {
        role: acc.role,
        content: acc.content,
        ...(acc.tool_calls ? { tool_calls: acc.tool_calls } : {}),
      },
      finish_reason: acc.finish_reason ?? null,
    }],
  }),
  synthesizeFinal: (acc, index, template) => {
    if (acc.finish_reason != null) return null;
    if (!acc.tool_calls && acc.content === "") return null;
    return {
      id: template.id,
      object: template.object,
      created: template.created,
      model: template.model,
      choices: [{ index, delta: {}, finish_reason: acc.tool_calls ? "tool_calls" : "stop" }],
    };
  },
};

export const ChatSyncChoiceSchema = z.looseObject({
  index: z.number(),
  message: z.looseObject({
    role: z.string(),
    content: z.string().nullable().optional(),
    tool_calls: z.array(z.looseObject({
      id: z.string(),
      type: z.string(),
      function: z.looseObject({ name: z.string(), arguments: z.string() }),
    })).optional(),
  }),
  finish_reason: z.string().nullable().optional(),
});

const chatNonStreamSpec: NonStreamSpec<z.infer<typeof ChatSyncChoiceSchema>> = {
  choicesSchema: z.array(ChatSyncChoiceSchema),
  toLogOutput: (choices, model) => ({ model, choices }),
};

export const handleChatCompletion = withEndpointGuards({
  modelTypes: ["chat"],
  bodySchema: ChatCompletionBodySchema,
  log,
  handler: async ({ auth, body, rawBody, modelInfo, originalModel, req }) => {
    if (body.structured_outputs && modelInfo.driver !== "vllm") {
      return errorResponse("structured_outputs is only supported with the vLLM driver", 400);
    }

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (hasTools && modelLacksToolSupport(modelInfo)) {
      return errorResponse("Model does not support tool use", 400);
    }

    const callStartTime = Date.now();

    const { messagesForLLM, messagesForDB } = await processMessageImages(
      body.messages as ApiCallInputMessage[],
      auth.orgId,
      imageStore,
    );

    const fetchBody: Record<string, unknown> = {
      model: modelInfo.model,
      messages: messagesForLLM,
      stream: body.stream,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      top_p: body.top_p,
      frequency_penalty: body.frequency_penalty,
      presence_penalty: body.presence_penalty,
      seed: body.seed,
      logprobs: body.logprobs,
      top_logprobs: body.top_logprobs,
      response_format: body.response_format,
      tools: body.tools,
      tool_choice: body.tool_choice,
    };
    if (body.stream) {
      fetchBody.stream_options = { include_usage: true };
    }
    if (body.structured_outputs) {
      fetchBody.structured_outputs = body.structured_outputs;
    }
    const extraParams = extractAllowedRequestParams(rawBody, modelInfo.requestParams);
    if (extraParams) {
      Object.assign(fetchBody, extraParams);
    }

    const logFields = {
      auth,
      modelInfo,
      modelSpecifier: originalModel,
      inputMessages: messagesForDB,
      callStartTime,
      logCalls: body.store,
      metadata: body.metadata ?? undefined,
    };

    const idle = body.stream ? createIdleTimeout() : undefined;
    const timeoutSignal = idle?.signal ?? AbortSignal.timeout(env.BACKEND_TIMEOUT_MS);
    const signal = AbortSignal.any([req.signal, timeoutSignal]);

    const backendResponse = await backendPostJson(modelInfo, "/v1/chat/completions", fetchBody, signal);

    return forwardOpenAIResponse({
      backendResponse,
      originalModel,
      stream: body.stream,
      streamSpec: chatStreamSpec,
      nonStreamSpec: chatNonStreamSpec,
      logFields,
      log,
      onStreamChunk: idle?.reset,
      onStreamEnd: idle?.clear,
    });
  },
});
