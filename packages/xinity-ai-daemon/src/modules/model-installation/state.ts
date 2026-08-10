import { reportInstallationStates } from "../tether-client";
import { getNodeId } from "../statekeeper";

type LifecycleState = "downloading" | "installing" | "ready" | "failed";

type InstallationStateEntry = {
  lifecycleState: LifecycleState;
  progress: number | null;
  statusMessage: string | null;
  errorMessage: string | null;
  failureLogs: string | null;
};

const localStateCache = new Map<string, InstallationStateEntry>();

export async function updateInstallationState(
  id: string,
  lifecycleState: LifecycleState,
  opts?: { statusMessage?: string; errorMessage?: string | null; progress?: number | null; failureLogs?: string | null },
): Promise<void> {
  const entry: InstallationStateEntry = {
    lifecycleState,
    progress: opts?.progress ?? null,
    statusMessage: opts?.statusMessage ?? null,
    errorMessage: opts?.errorMessage ?? null,
    failureLogs: opts?.failureLogs ?? null,
  };
  localStateCache.set(id, entry);

  const nodeId = await getNodeId();
  await reportInstallationStates({
    nodeId,
    states: [{
      installationId: id,
      lifecycleState,
      progress: opts?.progress,
      statusMessage: opts?.statusMessage,
      errorMessage: opts?.errorMessage,
      failureLogs: opts?.failureLogs,
    }],
  });
}

export function getLocalInstallationState(id: string): InstallationStateEntry | undefined {
  return localStateCache.get(id);
}

export function getLocalInstallationStates(ids: string[]): Map<string, InstallationStateEntry> {
  const result = new Map<string, InstallationStateEntry>();
  for (const id of ids) {
    const entry = localStateCache.get(id);
    if (entry) {
      result.set(id, entry);
    }
  }
  return result;
}
