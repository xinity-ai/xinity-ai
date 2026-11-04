import type { DeploymentOutput, StatusPhase } from "$lib/orpc/dtos/model.dto";
import type { ClusterOverview } from "$lib/server/orpc/procedures/cluster.procedure";

export type PhaseDisplay = { dot: string; chip: string; pulse: boolean; label: string };

export const PHASE_DISPLAY: Record<StatusPhase, PhaseDisplay> = {
  ready:          { dot: "bg-[#4ade80]",  chip: "bg-[#4ade80]/15 text-[#16a34a]",      pulse: false, label: "Ready" },
  partial:        { dot: "bg-[#f59e0b]",  chip: "bg-[#f59e0b]/15 text-[#d97706]",      pulse: false, label: "Partial" },
  failed:         { dot: "bg-destructive", chip: "bg-destructive/15 text-destructive", pulse: false, label: "Failed" },
  scheduling:     { dot: "bg-[#98B9FD]",  chip: "bg-[#98B9FD]/15 text-[#5b8ae6]",      pulse: true,  label: "Scheduling" },
  downloading:    { dot: "bg-primary",     chip: "bg-primary/15 text-primary",          pulse: true,  label: "Downloading" },
  installing:     { dot: "bg-primary",     chip: "bg-primary/15 text-primary",          pulse: true,  label: "Installing" },
  not_in_catalog: { dot: "bg-[#f59e0b]",  chip: "bg-[#f59e0b]/15 text-[#d97706]",      pulse: false, label: "Not in Catalog" },
};

/** A desired replica the orchestrator has not placed, rendered hollow so it reads as an empty slot. */
export const UNSCHEDULED_DISPLAY: PhaseDisplay = {
  dot: "border border-muted-foreground/50",
  chip: "bg-muted text-muted-foreground",
  pulse: false,
  label: "Not scheduled",
};

export const SLOT_DISPLAY = { ...PHASE_DISPLAY, unscheduled: UNSCHEDULED_DISPLAY };

export const DISABLED_DISPLAY: PhaseDisplay = { dot: "bg-muted-foreground/50", chip: "bg-muted text-muted-foreground", pulse: false, label: "Disabled" };

export const UNPLACED_DISPLAY: PhaseDisplay = { dot: "bg-amber-400", chip: "bg-amber-100 text-amber-700", pulse: false, label: "No node available" };

export const UNPLACED_EXPLANATION = "The orchestrator could not place this model on any node. Common causes: no node has enough free VRAM for the model weight, or no available node has the required driver. A node that was removed or is powered off no longer counts.";

export function statusDisplayOf(deployment: DeploymentOutput): PhaseDisplay {
  if (!deployment.enabled) {
    return DISABLED_DISPLAY;
  }
  return deployment.status ? PHASE_DISPLAY[deployment.status.phase] : UNPLACED_DISPLAY;
}

/** Still on its way to a settled state, so worth polling. Enabled without a status means not scheduled yet. */
export function isSettling(deployment: DeploymentOutput): boolean {
  if (!deployment.enabled) {
    return false;
  }
  if (!deployment.status) {
    return true;
  }
  return !["ready", "failed", "partial"].includes(deployment.status.phase);
}

export const isServing = (deployment: DeploymentOutput) =>
  deployment.status?.phase === "ready" || deployment.status?.phase === "partial";

/** Enabled but failing, partly placed, gone from the catalog, or placed nowhere. */
export function needsAttention(deployment: DeploymentOutput): boolean {
  if (!deployment.enabled) {
    return false;
  }
  return !deployment.status || ["failed", "partial", "not_in_catalog"].includes(deployment.status.phase);
}

export type LicensedVram = ClusterOverview["licensedVram"];
