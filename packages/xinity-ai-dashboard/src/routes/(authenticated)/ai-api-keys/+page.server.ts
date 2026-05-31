import { call } from "@orpc/server";
import { router } from "$lib/server/orpc/router";
import type { PageServerLoad } from "./$types";
import type { ApiKeyDto } from "$lib/orpc/dtos/api-key.dto";
import type { ApplicationDto } from "$lib/orpc/dtos/application.dto";

export const load: PageServerLoad = async ({ locals, depends, parent }) => {
  depends("resource:apikeys");
  const { activeOrganizationId, user } = await parent();
  if (!activeOrganizationId) {
    return {
      apiKeys: [] as ApiKeyDto[],
      applications: [] as ApplicationDto[],
      userId: user.id,
    }
  }

  const [apiKeys, applications] = await Promise.all([
    call(router.apiKey.list, {}, { context: locals }) as Promise<ApiKeyDto[]>,
    call(router.application.list, {}, { context: locals }),
  ]);

  return {
    apiKeys,
    applications,
    userId: user.id,
  };
};
