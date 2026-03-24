import { call } from "@orpc/server";
import { router } from "$lib/server/orpc/router";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, locals }) => {
  const page = Number(url.searchParams.get("page")) || 1;
  const search = url.searchParams.get("search") || undefined;

  const [usersResult, orgsResult] = await Promise.all([
    call(router.instanceAdmin.listUsers, { page, limit: 25, search }, { context: locals }),
    call(router.instanceAdmin.listOrganizations, { page: 1, limit: 100 }, { context: locals }),
  ]);

  return {
    users: usersResult.users,
    total: usersResult.total,
    page: usersResult.page,
    limit: usersResult.limit,
    search: search ?? "",
    organizations: orgsResult.organizations,
  };
};
