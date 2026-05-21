/**
 * Server-side re-export of roles.
 * The actual definitions are in $lib/roles.ts for client-safe access.
 */
export { ac, owner, admin, member, labeler, viewer, pending, roles } from "$lib/roles";
export type { RoleName } from "$lib/roles";
import type { RoleName } from "$lib/roles";
import { hasFeature } from "$lib/server/license";
import { z } from "zod";

/** All roles unlocked by the "all-roles" license feature. */
const ALL_ROLES = ["owner", "admin", "member", "labeler", "viewer", "pending"] as const satisfies readonly RoleName[];

/** Roles available without a license (free tier). "pending" is always included for SSO provisioning. */
const FREE_ROLES: readonly RoleName[] = ["owner", "admin", "pending"];

/** Zod schema for any valid role name. */
export const RoleSchema = z.enum(ALL_ROLES);

/**
 * Returns the set of assignable role names for the current license.
 * Free tier: owner, admin. Paid tiers with "all-roles": all five roles.
 */
export function getAvailableRoles(): readonly RoleName[] {
  return hasFeature("all-roles") ? ALL_ROLES : FREE_ROLES;
}

/** Returns true if the given role is available under the current license. */
export function isRoleAvailable(role: RoleName): boolean {
  return (getAvailableRoles() as readonly string[]).includes(role);
}
