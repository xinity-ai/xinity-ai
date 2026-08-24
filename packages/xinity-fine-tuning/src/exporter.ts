export interface ApiCallMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface RawApiCall {
  id: string;
  specifiedModel: string;
  inputMessages: ApiCallMessage[];
  outputMessage?: ApiCallMessage | { role: string; content: string } | null;
  rating?: number | null;
  metadata?: Record<string, any> | null;
}

export interface ChatMLDatasetItem {
  messages: ApiCallMessage[];
}

export interface ExportOptions {
  includeCodeIntelligence?: boolean;
  graphSymbolsContext?: string;
}

export class FineTuningExporter {
  /**
   * Converts raw API calls into ChatML JSONL dataset items for LoRA / QLoRA training.
   * Optionally augments dataset with Code Intelligence AST Graph context.
   */
  public static exportChatML(apiCalls: RawApiCall[], options?: ExportOptions): ChatMLDatasetItem[] {
    const dataset: ChatMLDatasetItem[] = [];

    for (const call of apiCalls) {
      if (!call.inputMessages || call.inputMessages.length === 0) continue;

      const messages: ApiCallMessage[] = [];

      if (options?.includeCodeIntelligence && options.graphSymbolsContext) {
        messages.push({
          role: 'system',
          content: `[Code Intelligence AST Context]\n${options.graphSymbolsContext}`
        });
      }

      for (const msg of call.inputMessages) {
        if (msg.role && msg.content) {
          messages.push({
            role: msg.role as 'system' | 'user' | 'assistant',
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          });
        }
      }

      if (call.outputMessage && call.outputMessage.content) {
        messages.push({
          role: 'assistant',
          content: typeof call.outputMessage.content === 'string'
            ? call.outputMessage.content
            : JSON.stringify(call.outputMessage.content)
        });
      }

      if (messages.length >= 2) {
        dataset.push({ messages });
      }
    }

    return dataset;
  }

  /**
   * Converts dataset items into stringified JSONL format ready for disk saving or Unsloth dataset loading.
   */
  public static toJSONL(dataset: ChatMLDatasetItem[]): string {
    return dataset.map(item => JSON.stringify(item)).join('\n');
  }

  /**
   * Splits dataset into train (e.g. 90%) and evaluation (e.g. 10%) subsets.
   */
  public static splitTrainEval(dataset: ChatMLDatasetItem[], trainRatio = 0.9): { train: ChatMLDatasetItem[]; eval: ChatMLDatasetItem[] } {
    const cutoff = Math.floor(dataset.length * trainRatio);
    return {
      train: dataset.slice(0, cutoff),
      eval: dataset.slice(cutoff)
    };
  }
}
