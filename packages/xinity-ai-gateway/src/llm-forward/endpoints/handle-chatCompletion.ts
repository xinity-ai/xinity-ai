import { z } from "zod";
import {
  errorResponse,
  forwardBackendError,
  validateModelType,
  extractAllowedRequestParams,
  handleEndpointError,
  validationError,
} from "../util";
import { resolveModel } from "../ai-sdk";
import { BackendChatChunkSchema } from "../backend-schemas";
import type { ApiCallInputMessage } from "common-db";
import { rootLogger } from "../../logger";
import { processMessageImages, imageStore } from "../../image-store";
import { env } from "../../env";
import { backendFetch, backendUrl } from "../backend-fetch";
import {
  forwardOpenAINonStream,
  forwardOpenAIStream,
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

type ChatAcc = {
  content: string;
  role: string;
  tool_calls?: unknown[];
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
    if (Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0) {
      acc.tool_calls = choice.delta.tool_calls;
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
};

const ChatSyncChoiceSchema = z.looseObject({
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

export async function handleChatCompletion(req: Request) {
  try {
    const resolved = await resolveModel(req);
    if (resolved instanceof Response) {
      return resolved;
    }

    const { auth, body: rawBody, originalModel, modelInfo } = resolved;

    const typeError = validateModelType(modelInfo, ["chat"]);
    if (typeError) {
      return typeError;
    }

    const parseResult = ChatCompletionBodySchema.safeParse(rawBody);
    if (!parseResult.success) {
      return validationError(parseResult.error);
    }
    const body = parseResult.data;

    if (body.structured_outputs && modelInfo.driver !== "vllm") {
      return errorResponse("structured_outputs is only supported with the vLLM driver", 400);
    }

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (hasTools && !modelInfo.tags.includes("tools")) {
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

    const backendResponse = await backendFetch(backendUrl(modelInfo.host, modelInfo.model, "/v1/chat/completions", modelInfo.tls), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fetchBody),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(env.BACKEND_TIMEOUT_MS)]),
      authToken: modelInfo.authToken ?? undefined,
    });

    if (!backendResponse.ok) {
      return forwardBackendError(backendResponse, log);
    }

    if (body.stream) {
      return forwardOpenAIStream({
        backendResponse,
        originalModel,
        spec: chatStreamSpec,
        logFields,
        log,
      });
    }

    return forwardOpenAINonStream({
      backendResponse,
      originalModel,
      spec: chatNonStreamSpec,
      logFields,
      log,
    });
  } catch (error) {
    return handleEndpointError(error, log);
  }
}
