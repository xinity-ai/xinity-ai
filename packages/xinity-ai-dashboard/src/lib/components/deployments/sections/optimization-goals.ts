import type { OptimizationGoal } from "common-env/deployment-settings";

export const OPTIMIZATION_GOAL_DISPLAY: Record<OptimizationGoal, { label: string; description: string }> = {
  space: {
    label: "Space",
    description: "Runs the model on as few GPUs as it fits on, leaving the rest free for other models.",
  },
  speed: {
    label: "Speed",
    description: "Splits the model across more GPUs of one node, so each request generates faster, where the model supports being split.",
  },
};
