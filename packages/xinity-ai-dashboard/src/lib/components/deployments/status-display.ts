import type { DeploymentOutput, StatusPhase } from "$lib/orpc/dtos/model.dto";
import type { ShortfallReason } from "$lib/server/lib/deployments/shortfall-reasons";
import type { ClusterOverview } from "$lib/server/orpc/procedures/cluster.procedure";

export type PhaseDisplay = { dot: string; chip: string; pulse: boolean; label: string; description: string };

const ON_ITS_WAY = "On its way to serving.";

// A ladder from fine to broken, so an operator sees at a glance how much a deployment needs them.
export const PHASE_DISPLAY: Record<StatusPhase, PhaseDisplay> = {
  ready: {
    dot: "bg-[#4ade80]", chip: "bg-[#4ade80]/15 text-[#16a34a]", pulse: false, label: "Healthy",
    description: "Every replica the deployment asks for runs and answers requests.",
  },
  partial: {
    dot: "bg-[#4ade80]/50", chip: "bg-[#4ade80]/10 text-[#16a34a]", pulse: false, label: "Reduced",
    description: "Answers requests correctly, with fewer replicas than it asks for, because some have no machine or failed. It handles less traffic at once.",
  },
  degraded: {
    dot: "bg-amber-400", chip: "bg-amber-100 text-amber-700", pulse: false, label: "Degraded",
    description: "Answers requests, but not as configured. During a rollout one model has no serving replica, so all traffic goes to the other one whatever the split says, and the rollout cannot be promoted.",
  },
  down: {
    dot: "bg-destructive", chip: "bg-destructive/15 text-destructive", pulse: false, label: "Down",
    description: "It ran, but the machines its replicas ran on went offline and no other machine can take them. Requests to it fail.",
  },
  failed: {
    dot: "bg-destructive", chip: "bg-destructive/15 text-destructive", pulse: false, label: "Failed",
    description: "Its replicas failed to start or stopped with an error. Its page shows the error and the logs, and Retry starts them again.",
  },
  scheduling: { dot: "bg-[#98B9FD]", chip: "bg-[#98B9FD]/15 text-[#5b8ae6]", pulse: true, label: "Scheduling", description: ON_ITS_WAY },
  downloading: { dot: "bg-primary", chip: "bg-primary/15 text-primary", pulse: true, label: "Downloading", description: ON_ITS_WAY },
  installing: { dot: "bg-primary", chip: "bg-primary/15 text-primary", pulse: true, label: "Installing", description: ON_ITS_WAY },
  not_in_catalog: {
    dot: "bg-[#f59e0b]", chip: "bg-[#f59e0b]/15 text-[#d97706]", pulse: false, label: "Not in Catalog",
    description: "The model catalog no longer lists its model, so it cannot be placed. Change it to a model the catalog has.",
  },
};

export const UNSCHEDULED_DISPLAY: PhaseDisplay = {
  dot: "border border-muted-foreground/50",
  chip: "bg-muted text-muted-foreground",
  pulse: false,
  label: "Not scheduled",
  description: "No machine has taken this replica yet.",
};

// A single replica either serves or does not, so it has no health of its own.
export const SLOT_DISPLAY = {
  ...PHASE_DISPLAY,
  ready: { ...PHASE_DISPLAY.ready, label: "Serving", description: "Answers requests." },
  unscheduled: UNSCHEDULED_DISPLAY,
};

export const DISABLED_DISPLAY: PhaseDisplay = {
  dot: "bg-muted-foreground/50", chip: "bg-muted text-muted-foreground", pulse: false, label: "Disabled",
  description: "Runs nowhere, and requests to it fail.",
};

export const UNPLACED_DISPLAY: PhaseDisplay = {
  dot: "bg-amber-400", chip: "bg-amber-100 text-amber-700", pulse: false, label: "Not placed",
  description: "Enabled, but no machine has taken it yet, for lack of free memory, of room under the license, or of a machine with the engine the model needs. It is placed on its own once that changes.",
};

export function statusDisplayOf(deployment: DeploymentOutput): PhaseDisplay {
  if (!deployment.enabled) {
    return DISABLED_DISPLAY;
  }
  return deployment.status ? PHASE_DISPLAY[deployment.status.phase] : UNPLACED_DISPLAY;
}

export function isSettling(deployment: DeploymentOutput): boolean {
  if (!deployment.enabled) {
    return false;
  }
  if (!deployment.status) {
    return true;
  }
  return !["ready", "failed", "partial", "degraded", "down"].includes(deployment.status.phase);
}

export const isServing = (deployment: DeploymentOutput) =>
  ["ready", "partial", "degraded"].includes(deployment.status?.phase ?? "");

// Short of replicas still serves, so "partial" does not count.
export function needsAttention(deployment: DeploymentOutput): boolean {
  if (!deployment.enabled) {
    return false;
  }
  return !deployment.status || ["failed", "down", "not_in_catalog", "degraded"].includes(deployment.status.phase);
}

export type LicensedVram = ClusterOverview["licensedVram"];

export type ShortfallFix = {
  text: string;
  /** How long a replica that cannot be placed waits, as the end of "waits ..." */
  waitsUntil: string;
  link?: { href: string; label: string };
  fewerReplicasHelp: boolean;
  resolvesOnItsOwn: boolean;
};

const SHORTFALL_FIXES: Record<ShortfallReason, ShortfallFix> = {
  catalog_unavailable: { text: "This clears on its own once the model catalog is back.", waitsUntil: "until the catalog is back", fewerReplicasHelp: false, resolvesOnItsOwn: true },
  not_found: { text: "Change the deployment to a model the catalog has.", waitsUntil: "until the model is in the catalog", fewerReplicasHelp: false, resolvesOnItsOwn: false },
  no_compatible_node: { text: "It is placed on its own once a machine with the engine this model needs joins.", waitsUntil: "until a machine can run the model", fewerReplicasHelp: false, resolvesOnItsOwn: true },
  no_machine_left: { text: "Each machine runs one replica, so lower the replica count or add a machine.", waitsUntil: "until a machine is added", fewerReplicasHelp: true, resolvesOnItsOwn: false },
  no_capacity: { text: "It is placed on its own once a machine has room, from a new machine or memory another deployment frees.", waitsUntil: "until memory is free", fewerReplicasHelp: false, resolvesOnItsOwn: true },
  license_limit: {
    text: "It is placed on its own once the license allows more VRAM, or other deployments free some.",
    waitsUntil: "until the license allows it",
    link: { href: "https://xinity.ai/xinity-pricing", label: "Upgrade the license" },
    fewerReplicasHelp: false,
    resolvesOnItsOwn: true,
  },
};

export const shortfallFix = (reason: ShortfallReason) => SHORTFALL_FIXES[reason];
