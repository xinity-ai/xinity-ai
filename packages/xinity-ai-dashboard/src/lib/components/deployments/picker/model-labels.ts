import type { Engine, ModelType } from "common-env/model-catalog";

export const ENGINE_LABELS: Record<Engine, string> = { vllm: "vLLM", ollama: "Ollama" };

export const DRIVER_FEATURE_LABELS: Record<string, string> = { audio: "audio support", "vllm-omni": "vllm-omni" };

export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  chat: "Chat",
  embedding: "Embedding",
  rerank: "Rerank",
  transcription: "Transcription",
  image: "Image",
};
