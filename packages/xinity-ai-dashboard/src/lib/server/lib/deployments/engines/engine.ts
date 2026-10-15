import type { OptimizationGoal } from "common-env";
import type { SchedulableModel } from "$lib/server/lib/models/model-catalog";
import type { NodeResources } from "../cluster-state";
import type { Placement } from "../placement";
import type { DeploymentStrategy } from "../strategy";

export type PlacementModel = Pick<SchedulableModel, "weight" | "attentionHeads" | "kvHeads" | "mlaAttention" | "footprint">;

export type PlacementRequest = { model: PlacementModel; kvCacheGb: number; goal: OptimizationGoal; strategy: DeploymentStrategy };

export type Charge = { estCapacity: number; hostCapacity: number };

export type NodeSlot = Charge & { gpuIds: string[] };

export type EngineScheduler = {
  // Whether an installation already on a node rules out placing the candidate there too.
  excludes: (placed: Placement, candidate: Placement) => boolean;
  // Where on the node an installation goes and what it occupies there, or undefined when it does not fit.
  placeOnNode: (node: NodeResources, request: PlacementRequest) => NodeSlot | undefined;
  charge: (node: NodeResources, request: Omit<PlacementRequest, "goal" | "strategy">, cards: number) => Charge | undefined;
  // The cards that carry an installation's capacity.
  occupiedCards: (cards: NodeResources["cards"], gpuIds: string[]) => NodeResources["cards"];
  // The port a new installation listens on, given the ports already taken on its node.
  port: (usedPorts: ReadonlySet<number>) => number;
};
