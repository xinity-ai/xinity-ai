import type { EngineScheduler } from "./engine";

const OLLAMA_PORT = 11434;

// One Ollama server per node holds a single copy of each tag on its own port, so a tag never lands
// on a node twice and Ollama places models itself rather than on cards we choose.
export const ollamaScheduler: EngineScheduler = {
  excludes: (placed, candidate) => placed.specifier === candidate.specifier,
  placeOnNode: (_node, request) => ({ gpuIds: [], estCapacity: request.model.weight + request.kvCacheGb, hostCapacity: 0 }),
  charge: (_node, request) => ({ estCapacity: request.model.weight + request.kvCacheGb, hostCapacity: 0 }),
  occupiedCards: () => [],
  port: () => OLLAMA_PORT,
};
