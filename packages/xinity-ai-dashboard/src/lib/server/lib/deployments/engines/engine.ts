import type { OptimizationGoal } from "common-env";
import type { SchedulableModel } from "$lib/server/lib/models/model-catalog";
import type { NodeResources } from "../cluster-state";
import type { Placement } from "../placement";
import type { DeploymentStrategy } from "../strategy";

export type PlacementModel = Pick<SchedulableModel, "weight" | "attentionHeads" | "kvHeads" | "mlaAttention" | "footprint">;

export type PlacementRequest = { model: PlacementModel; kvCacheGb: number; goal: OptimizationGoal; strategy: DeploymentStrategy };

export type Charge = { estCapacity: number; hostCapacity: number; maxNumSeqs: number | null };

export type NodeSlot = Charge & { gpuIds: string[] };

export type CandidateNode = { nodeId: string; node: NodeResources };

export type MemberSlot = NodeSlot & { nodeId: string };

export type EngineScheduler = {
  excludes: (placed: Placement, candidate: Placement) => boolean;
  placeOnNode: (node: NodeResources, request: PlacementRequest) => NodeSlot | undefined;
  groupsAcrossNodes?: (candidates: CandidateNode[], request: PlacementRequest) => MemberSlot[][];
  charge: (node: NodeResources, request: Omit<PlacementRequest, "goal" | "strategy">, cards: number) => Charge | undefined;
  occupiedCards: (cards: NodeResources["cards"], gpuIds: string[]) => NodeResources["cards"];
  port: (usedPorts: ReadonlySet<number>) => number;
};
