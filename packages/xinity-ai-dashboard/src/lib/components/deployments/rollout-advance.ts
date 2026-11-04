import type { RolloutAdvance } from "common-env/rollout-advance";
import type { DeploymentOf, RolloutAdvanceInput } from "$lib/orpc/dtos/model.dto";
import { handleVariant, type VariantHandlers } from "$lib/util";

/** An advance as a form edits it: the time policy as hours from now instead of a date. `stored` keeps the end of a schedule
 * that already runs, so leaving its hours alone does not move its end to whole hours from now. */
export type AdvanceDraft = { type: "manual" } | { type: "time"; hours: number; stored?: { hours: number; until: string } };

export const HOUR_MS = 3_600_000;

export const DEFAULT_ROLLOUT_HOURS = 24;
export const MIN_ROLLOUT_HOURS = 1;
// A quarter year bounds a typo, not a real schedule.
export const MAX_ROLLOUT_HOURS = 24 * 90;

// A cleared or zero field would end the rollout at once and move all traffic, so a schedule runs an hour at least.
export const rolloutEndAt = (hours: number | null) => new Date(Date.now() + Math.max(MIN_ROLLOUT_HOURS, hours || 0) * HOUR_MS);

export const endOfDraft = ({ hours, stored }: Extract<AdvanceDraft, { type: "time" }>) =>
  stored && stored.hours === hours ? new Date(stored.until) : rolloutEndAt(hours);

const DRAFT_OF_STORED: VariantHandlers<RolloutAdvance, AdvanceDraft> = {
  manual: () => ({ type: "manual" }),
  time: ({ until }) => {
    const hours = Math.max(MIN_ROLLOUT_HOURS, Math.round((Date.parse(until) - Date.now()) / HOUR_MS));
    return { type: "time", hours, stored: { hours, until } };
  },
};

const INPUT_OF_DRAFT: VariantHandlers<AdvanceDraft, RolloutAdvanceInput> = {
  manual: () => ({ type: "manual" }),
  time: (draft) => ({ type: "time", until: endOfDraft(draft) }),
};

export const advanceDraftOf = (advance: RolloutAdvance) => handleVariant(DRAFT_OF_STORED, advance);
export const advanceInputOf = (draft: AdvanceDraft) => handleVariant(INPUT_OF_DRAFT, draft);

export const newModelServes = (deployment: DeploymentOf<"canary">) =>
  (deployment.status?.replicas ?? []).some((replica) => replica.side === "to" && replica.phase === "ready");
