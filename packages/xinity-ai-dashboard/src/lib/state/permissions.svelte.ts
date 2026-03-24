/**
 * Permissions state for client-side permission checking.
 * Uses better-auth's organization.checkRolePermission for synchronous UI decisions.
 */
import { organization } from "$lib/auth";
import { browserLogger } from "$lib/browserLogging";
import type { RoleName } from "$lib/roles";

const log = browserLogger.child({ name: "permissions_manager" });

type Resource = "apiKey" | "apiCall" | "apiCallResponse" | "modelDeployment" | "model" | "aiApplication" | "organization" | "member" | "invitation";
type Action = "create" | "read" | "update" | "delete";

// Reactive state
let role = $state<RoleName | null>(null);
let loading = $state(true);

/**
 * Set the role directly (used when role is loaded server-side)
 */
function setRole(newRole: RoleName | null) {
  log.debug({ newRole }, "Setting role directly");
  role = newRole;
  loading = false;
}

/**
 * Refresh permissions by fetching the active member's role (client-side fallback)
 */
async function refresh() {
  log.info("Refreshing permissions");
  loading = true;
  try {
    const memberResult = await organization.getActiveMember();
    log.info({ memberResult }, "Active member result");

    if (memberResult.data?.role) {
      role = memberResult.data.role as RoleName;
      log.info({ role }, "Role set from getActiveMember");
    } else {
      log.warn("Could not determine role from getActiveMember");
    }
  } catch (err) {
    log.error({ err }, "Error refreshing permissions");
    role = null;
  } finally {
    loading = false;
  }
}

/**
 * Check if the current role has permission for a specific action on a resource.
 */
function can(resource: Resource, action: Action): boolean {
  if (!role) {
    return false;
  }

  try {
    const result = organization.checkRolePermission({
      permissions: { [resource]: [action] },
      role: role,
    });
    return result;
  } catch (err) {
    log.error({ err, resource, action, role }, "Error checking permission");
    return false;
  }
}

/**
 * Check if the current role has any of the specified permissions.
 */
function canAny(perms: Partial<Record<Resource, Action[]>>): boolean {
  if (!role) return false;

  for (const [resource, actions] of Object.entries(perms)) {
    for (const action of actions || []) {
      if (can(resource as Resource, action as Action)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if the current role has all of the specified permissions.
 */
function canAll(perms: Partial<Record<Resource, Action[]>>): boolean {
  if (!role) return false;

  for (const [resource, actions] of Object.entries(perms)) {
    for (const action of actions || []) {
      if (!can(resource as Resource, action as Action)) {
        return false;
      }
    }
  }
  return true;
}

// Export as a reactive object with getters for convenience properties
export const permissions = {
  get role() { return role; },
  get loading() { return loading; },
  setRole,
  refresh,
  can,
  canAny,
  canAll,

  // Convenience getters
  get canViewApiKeys() {
    return can("apiKey", "read");
  },
  get canManageApiKeys() {
    return can("apiKey", "create");
  },
  get canViewData() {
    return can("apiCall", "read");
  },
  get canViewModels() {
    return can("model", "read");
  },
  get canManageModels() {
    return can("model", "create");
  },
  get canViewDeployments() {
    return can("modelDeployment", "read");
  },
  get canManageDeployments() {
    return can("modelDeployment", "create");
  },
  get canViewApplications() {
    return can("aiApplication", "read");
  },
  get canManageApplications() {
    return can("aiApplication", "create");
  },
  get canManageOrganization() {
    return can("organization", "update");
  },
  get canInviteMembers() {
    return can("invitation", "create");
  },
};
