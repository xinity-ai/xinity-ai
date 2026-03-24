import { call } from "@orpc/server";
import { router } from "$lib/server/orpc/router";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, locals }) => {
  const page = Number(url.searchParams.get("page")) || 1;
  const search = url.searchParams.get("search") || undefined;

  const result = await call(
    router.instanceAdmin.listOrganizations,
    { page, limit: 25, search },
    { context: locals },
  );

  return {
    organizations: result.organizations,
    total: result.total,
    page: result.page,
    limit: result.limit,
    search: search ?? "",
  };
};
