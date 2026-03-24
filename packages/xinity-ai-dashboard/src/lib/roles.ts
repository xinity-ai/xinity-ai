/**
 * Client-safe role and access control definitions.
 * This file can be imported on both client and server.
 */
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";

/**
 * Define the resources and actions for the application.
 * This extends the default organization resources (organization, member, invitation).
 */
const statement = {
  ...defaultStatements,
  apiKey: ["create", "update", "delete", "read"],
  apiCall: ["read", "delete"],
  apiCallResponse: ["create", "update", "delete", "read"],
  modelDeployment: ["create", "update", "delete", "read"],
  model: ["create", "update", "delete", "read"],
  aiApplication: ["create", "update", "delete", "read"],
} as const;

export const ac = createAccessControl(statement);

export const owner = ac.newRole({
  apiKey: ["create", "update", "delete", "read"],
  apiCall: ["read", "delete"],
  apiCallResponse: ["create", "update", "delete"],
  modelDeployment: ["create", "update", "delete", "read"],
  model: ["create", "update", "delete", "read"],
  aiApplication: ["create", "update", "delete", "read"],
  ...ownerAc.statements,
});

export const admin = ac.newRole({
  apiKey: ["create", "update", "delete", "read"],
  apiCall: ["read", "delete"],
  apiCallResponse: ["create", "update", "delete"],
  modelDeployment: ["create", "update", "delete", "read"],
  model: ["create", "update", "delete", "read"],
  aiApplication: ["create", "update", "delete", "read"],
  ...adminAc.statements,
});

export const member = ac.newRole({
  apiKey: ["create", "update", "delete", "read"],
  apiCall: ["read", "delete"],
  apiCallResponse: ["create", "update", "delete"],
  modelDeployment: ["create", "update", "delete", "read"],
  model: ["create", "update", "delete", "read"],
  aiApplication: ["create", "update", "delete", "read"],
  ...memberAc.statements,
});

export const labeler = ac.newRole({
  apiCallResponse: ["create", "delete", "update"],
  apiCall: ["read"],
  model: ["read"],
  aiApplication: ["read"],
  ...memberAc.statements,
});

export const viewer = ac.newRole({
  apiCall: ["read"],
  modelDeployment: ["read"],
  model: ["read"],
  apiCallResponse: ["read"],
  aiApplication: ["read"],
  ...memberAc.statements,
});

export const pending = ac.newRole({
  ...memberAc.statements,
});

export const roles = {
  owner,
  admin,
  member,
  labeler,
  viewer,
  pending,
};

export type RoleName = keyof typeof roles;

export const roleLabels: Record<RoleName, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  labeler: "Labeler",
  viewer: "Viewer",
  pending: "Pending",
};

export const roleBadgeVariant: Record<RoleName, "default" | "secondary" | "destructive" | "outline"> = {
  owner: "default",
  admin: "default",
  member: "secondary",
  labeler: "outline",
  viewer: "outline",
  pending: "outline",
};
