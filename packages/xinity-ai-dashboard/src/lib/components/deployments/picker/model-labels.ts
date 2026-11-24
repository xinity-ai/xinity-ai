import type { Engine, ModelType } from "common-env/model-catalog";

export const ENGINE_LABELS: Record<Engine, string> = { vllm: "vLLM", ollama: "Ollama" };

export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  chat: "Chat",
  embedding: "Embedding",
  rerank: "Rerank",
  transcription: "Transcription",
  image: "Image",
};
