import type { OptimizationGoal } from "common-env/deployment-settings";

export const OPTIMIZATION_GOAL_DISPLAY: Record<OptimizationGoal, { label: string; summary: string; description: string }> = {
  space: {
    label: "Space",
    summary: "uses as few GPUs as possible",
    description: "Runs the model on as few GPUs as it fits on, leaving the rest free for other models.",
  },
  speed: {
    label: "Speed",
    summary: "spreads across more GPUs to answer faster",
    description: "Splits the model across more GPUs of one node, so each request generates faster, where the model supports being split.",
  },
};
