import { getDB } from "../../db/connection";
import { modelInstallationStateT } from "common-db";

export async function updateInstallationState(
  id: string,
  lifecycleState: "downloading" | "installing" | "ready" | "failed",
  opts?: { statusMessage?: string; errorMessage?: string | null; progress?: number | null; failureLogs?: string | null },
): Promise<void> {
  const fields = {
    lifecycleState,
    progress: opts?.progress ?? null,
    statusMessage: opts?.statusMessage ?? null,
    errorMessage: opts?.errorMessage ?? null,
    failureLogs: opts?.failureLogs ?? null,
  };
  await getDB()
    .insert(modelInstallationStateT)
    .values({ id, ...fields })
    .onConflictDoUpdate({ set: fields, target: modelInstallationStateT.id });
}
