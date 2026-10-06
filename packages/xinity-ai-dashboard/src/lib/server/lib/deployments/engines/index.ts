import type { Provider } from "common-env/model-catalog";
import type { EngineScheduler } from "./engine";
import { ollamaScheduler } from "./ollama";
import { vllmScheduler } from "./vllm";

export const ENGINE_SCHEDULERS: Record<Provider, EngineScheduler> = {
  ollama: ollamaScheduler,
  vllm: vllmScheduler,
};
