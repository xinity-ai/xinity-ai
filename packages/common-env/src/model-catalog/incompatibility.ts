import { z } from "zod";

export const IncompatibilityReasonEnum = z.enum([
  "missing_driver",
  "version_too_old",
  "version_unknown",
  "version_blocked",
  "missing_feature",
  "wrong_platform",
  "insufficient_capacity",
]);
export type IncompatibilityReason = z.infer<typeof IncompatibilityReasonEnum>;

/** How far through checkNodeCompatibility's ordered checks a node got before failing. */
const REASON_PROGRESS: Record<IncompatibilityReason, number> = {
  missing_driver: 0,
  version_unknown: 1,
  version_too_old: 1,
  version_blocked: 1,
  missing_feature: 2,
  wrong_platform: 3,
  insufficient_capacity: 4,
};

/**
 * Collapses the outcomes of several candidates into one: null if any candidate worked,
 * otherwise the reason from the one that came closest.
 *
 * Reporting the closest matters: a cluster where one node is merely full and another
 * lacks the driver is a capacity problem, not a driver problem. The same holds across
 * the variants of one model, where a quantization that fits beats one that does not.
 */
export function nearestIncompatibility(
  reasons: Iterable<IncompatibilityReason | null>,
): IncompatibilityReason | null {
  let closest: IncompatibilityReason = "missing_driver";
  for (const reason of reasons) {
    if (reason === null) {
      return null;
    }
    if (REASON_PROGRESS[reason] > REASON_PROGRESS[closest]) {
      closest = reason;
    }
  }
  return closest;
}
