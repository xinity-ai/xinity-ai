export const SHORTFALL_REASON_CODES = ["catalog_unavailable", "not_found", "no_compatible_node", "no_machine_left", "no_capacity", "license_limit"] as const;
export type ShortfallReason = (typeof SHORTFALL_REASON_CODES)[number];
