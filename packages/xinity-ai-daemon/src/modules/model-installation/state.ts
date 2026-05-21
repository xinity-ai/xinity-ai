import { getDB } from "../../db/connection";
import { lifecycleStateEnum, modelInstallationStateT } from "common-db";

type LifecycleState = typeof lifecycleStateEnum.enumValues[number];

export async function updateInstallationState(
  id: string,
  lifecycleState: LifecycleState,
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
