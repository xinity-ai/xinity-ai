// Shared utilities and constants for organization page components

import type { RoleName } from "$lib/roles";

export function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    return name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
  }
  return email?.charAt(0).toUpperCase() || "?";
}

export function getAvailableRoles(role: RoleName): RoleName[] {
  switch(role){
    case "owner":
      return [
        "member",
        "admin",
        "labeler",
        "viewer",
        "pending",
      ];
    case "admin":
      return [
        "member",
        "labeler",
        "viewer",
        "pending",
      ];
    
  }
  return [];
}
