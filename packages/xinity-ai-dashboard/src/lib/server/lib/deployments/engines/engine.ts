import type { OptimizationGoal } from "common-env";
import type { SchedulableModel } from "$lib/server/lib/models/model-catalog";
import type { CardCapacity } from "../cluster-state";
import type { Placement } from "../placement";
import type { DeploymentStrategy } from "../strategy";

export type PlacementModel = Pick<SchedulableModel, "weight" | "attentionHeads" | "kvHeads" | "mlaAttention">;

export type PlacementRequest = { model: PlacementModel; kvCacheGb: number; goal: OptimizationGoal; strategy: DeploymentStrategy };

export type NodeSlot = { gpuUuids: string[]; estCapacity: number };

export type EngineScheduler = {
  // Whether an installation already on a node rules out placing the candidate there too.
  excludes: (placed: Placement, candidate: Placement) => boolean;
  // Where on the node's cards an installation goes and the VRAM it occupies there, or undefined when it does not fit them.
  placeOnNode: (cards: CardCapacity[], request: PlacementRequest) => NodeSlot | undefined;
  // The cards that carry an installation's capacity.
  occupiedCards: (cards: CardCapacity[], gpuUuids: string[]) => CardCapacity[];
  // The port a new installation listens on, given the ports already taken on its node.
  port: (usedPorts: ReadonlySet<number>) => number;
};
