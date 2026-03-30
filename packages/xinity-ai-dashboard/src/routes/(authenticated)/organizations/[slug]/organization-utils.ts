// Shared utilities and constants for organization page components

import type { RoleName } from "$lib/roles";

export function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    return name.split(" ").filter(Boolean).map(n => n[0]).join("").toUpperCase().slice(0, 2);
  }
  return email?.charAt(0).toUpperCase() || "?";
}

/** Roles that require the "all-roles" license feature. */
const LICENSED_ROLES: RoleName[] = ["member", "labeler", "viewer"];

export function getAvailableRoles(role: RoleName, allRoles = true): RoleName[] {
  let roles: RoleName[];
  switch(role){
    case "owner":
      roles = [
        "member",
        "admin",
        "labeler",
        "viewer",
        "pending",
      ];
      break;
    case "admin":
      roles = [
        "member",
        "labeler",
        "viewer",
        "pending",
      ];
      break;
    default:
      return [];
  }
  if (!allRoles) {
    roles = roles.filter(r => !LICENSED_ROLES.includes(r));
  }
  return roles;
}
