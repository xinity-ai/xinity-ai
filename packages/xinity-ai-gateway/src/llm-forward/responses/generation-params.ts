import { Output, jsonSchema, type ToolChoice, type ModelMessage, type ToolSet } from "ai";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import type { CreateResponseBody } from "./schemas";

// ---------------------------------------------------------------------------
// Output config (structured output / json schema)
// ---------------------------------------------------------------------------

export type TextConfig = {
  format?: {
    type?: string;
    json_schema?: { name?: string; schema?: unknown };
  };
};

export type OutputConfig = {
  output?: ReturnType<typeof Output.text> | ReturnType<typeof Output.object> | ReturnType<typeof Output.json>;
  usesStructuredOutput: boolean;
};

/** Maps the `text.format` request field to the AI-SDK output mode. */
export function buildOutputConfig(textConfig: TextConfig | null): OutputConfig {
  const formatType = textConfig?.format?.type ?? "text";
  if (formatType === "json_schema" && textConfig?.format?.json_schema?.schema) {
    return {
      output: Output.object({
        schema: jsonSchema(textConfig.format.json_schema.schema),
        name: textConfig.format.json_schema.name,
      }),
      usesStructuredOutput: true,
    };
  }
  if (formatType === "json" || formatType === "json_object") {
    return { output: Output.json(), usesStructuredOutput: true };
  }
  return { output: Output.text(), usesStructuredOutput: false };
}

/**
 * If structured output was requested, serialize the parsed object; otherwise
 * pass text through.
 *
 * `getOutput` is a thunk so that the AI-SDK lazy getter (`result.output`) is
 * only evaluated when we actually need it. Eagerly passing `result.output` as
 * a plain value triggers the getter unconditionally and throws
 * `NoOutputGeneratedError` when the model returned no structured content.
 */
export function resolveResponseText(text: string, getOutput: () => unknown, usesStructuredOutput: boolean): string {
  if (usesStructuredOutput) {
    try {
      const output = getOutput();
      if (output !== undefined) {
        return JSON.stringify(output);
      }
    } catch {
      // AI SDK throws NoOutputGeneratedError when the model didn't produce
      // structured output. Fall through to return raw text instead of crashing.
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// AI-SDK generation parameters
// ---------------------------------------------------------------------------

function mapToolChoice(choice: CreateResponseBody["tool_choice"]): ToolChoice<ToolSet> | undefined {
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  if (typeof choice === "object" && choice !== null && "name" in choice && typeof choice.name === "string") {
    return { type: "tool", toolName: choice.name };
  }
  return undefined;
}

/** Assembles the common parameters shared by `generateText` and `streamText`. */
export function buildGenerationParams(
  body: CreateResponseBody,
  modelInfo: { model: string },
  provider: OpenAICompatibleProvider,
  messages: ModelMessage[],
  activeTools: ToolSet,
  hasTools: boolean,
  outputConfig: OutputConfig,
  signal?: AbortSignal,
) {
  return {
    model: provider.chatModel(modelInfo.model),
    messages,
    temperature: body.temperature,
    maxOutputTokens: body.max_output_tokens ?? body.max_tokens,
    topP: body.top_p,
    frequencyPenalty: body.frequency_penalty,
    presencePenalty: body.presence_penalty,
    seed: body.seed,
    abortSignal: signal,
    providerOptions: body.reasoning?.effort
      ? { openaiCompatible: { reasoningEffort: body.reasoning.effort } }
      : undefined,
    tools: hasTools ? activeTools : undefined,
    toolChoice: hasTools ? mapToolChoice(body.tool_choice) : undefined,
    stopWhen: hasTools ? (() => false) : undefined,
    output: outputConfig.output,
  };
}
