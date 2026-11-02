import type { EngineScheduler, PlacementRequest } from "./engine";

const OLLAMA_PORT = 11434;

const chargeOf = ({ model, kvCacheGb }: Pick<PlacementRequest, "model" | "kvCacheGb">) => ({
  estCapacity: model.weight + kvCacheGb,
  hostCapacity: 0,
  maxNumSeqs: null,
  parts: [{ part: "weights" as const, gb: model.weight }, { part: "kvCache" as const, gb: kvCacheGb }].filter(({ gb }) => gb > 0),
});

// One Ollama server per node holds a single copy of each tag on its own port, so a tag never lands
// on a node twice and Ollama places models itself rather than on cards we choose.
export const ollamaScheduler: EngineScheduler = {
  excludes: (placed, candidate) => placed.specifier === candidate.specifier,
  placeOnNode: (_node, request) => ({ gpuIds: [], ...chargeOf(request) }),
  charge: (_node, request) => chargeOf(request),
  occupiedCards: () => [],
  port: () => OLLAMA_PORT,
};
