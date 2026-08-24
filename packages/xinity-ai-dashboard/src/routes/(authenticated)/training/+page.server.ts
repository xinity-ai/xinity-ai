import type { PageServerLoad } from "./$types";
import { router } from "$lib/server/orpc/router";
import { call } from "@orpc/server";

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { session } = await parent();
  const activeOrgId = session.activeOrganizationId;

  if (!activeOrgId) {
    return {
      datasets: { totalApiCalls: 0, datasetItemCount: 0, jsonlPreview: "", jsonlFull: "" },
      jobs: []
    };
  }

  const [datasets, jobs] = await Promise.all([
    call(router.fineTuning.listDatasets, { limit: 500 }, { context: locals }).catch(() => ({
      totalApiCalls: 0,
      datasetItemCount: 0,
      jsonlPreview: "",
      jsonlFull: ""
    })),
    call(router.fineTuning.listJobs, {}, { context: locals }).catch(() => [])
  ]);

  return { datasets, jobs };
};
