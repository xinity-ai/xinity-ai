import { error } from "@sveltejs/kit";
import type { ac } from "../roles";
import { auth } from "../auth-server";

type Resource = keyof typeof ac.statements;
type Action<R extends Resource> = (typeof ac.statements)[R][number];
export type PermissionSpec = { [R in Resource]?: Action<R>[] };

export async function assertOrgPermission(headers: Headers, organizationId: string, permissions: PermissionSpec) {
  const result = await auth.api.hasPermission({ headers, body: { permissions, organizationId } });
  if (!result.success) {
    error(403, "Forbidden");
  }
}
