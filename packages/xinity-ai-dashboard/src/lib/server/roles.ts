/**
 * Server-side re-export of roles.
 * The actual definitions are in $lib/roles.ts for client-safe access.
 */
export { ac, owner, admin, member, labeler, viewer, pending, roles } from "$lib/roles";
export type { RoleName } from "$lib/roles";
import type { RoleName } from "$lib/roles";
import { hasFeature } from "$lib/server/license";

/** Roles available without a license (free tier). */
const FREE_ROLES: readonly RoleName[] = ["owner", "admin", "pending"];

/**
 * Returns the set of assignable role names for the current license.
 * Free tier: owner, admin. Paid tiers with "all-roles": all five roles.
 * "pending" is always included (used internally for SSO provisioning).
 */
export function getAvailableRoles(): readonly RoleName[] {
  if (hasFeature("all-roles")) {
    return ["owner", "admin", "member", "labeler", "viewer", "pending"];
  }
  return FREE_ROLES;
}

/** Returns true if the given role is available under the current license. */
export function isRoleAvailable(role: RoleName): boolean {
  return (getAvailableRoles() as readonly string[]).includes(role);
}
