import { reportInstallationStates } from "../tether-client";
import { getNodeId } from "../statekeeper";
import type { GroupStage } from "common-env";

type LifecycleState = "downloading" | "installing" | "ready" | "failed";

type InstallationStateEntry = {
  lifecycleState: LifecycleState;
  progress: number | null;
  statusMessage: string | null;
  errorMessage: string | null;
  failureLogs: string | null;
  groupStage: GroupStage | null;
  groupGeneration: number | null;
};

const localStateCache = new Map<string, InstallationStateEntry>();
const acceptedByTether = new Map<string, InstallationStateEntry>();

export async function updateInstallationState(
  id: string,
  lifecycleState: LifecycleState,
  opts?: { statusMessage?: string; errorMessage?: string | null; progress?: number | null; failureLogs?: string | null; groupStage?: GroupStage | null; groupGeneration?: number | null },
): Promise<void> {
  const entry: InstallationStateEntry = {
    lifecycleState,
    progress: opts?.progress ?? null,
    statusMessage: opts?.statusMessage ?? null,
    errorMessage: opts?.errorMessage ?? null,
    failureLogs: opts?.failureLogs ?? null,
    groupStage: opts?.groupStage !== undefined ? opts.groupStage : localStateCache.get(id)?.groupStage ?? null,
    groupGeneration: opts?.groupGeneration !== undefined ? opts.groupGeneration : localStateCache.get(id)?.groupGeneration ?? null,
  };
  localStateCache.set(id, entry);
  await reportLatestState(id);
}

export async function reportUnacceptedStates(ids: string[]): Promise<void> {
  await Promise.all(ids.map(reportLatestState));
}

const reportChains = new Map<string, Promise<void>>();

// Reports of one installation go out one after another, so an older state can never land after a newer one.
function reportLatestState(id: string): Promise<void> {
  const report = (reportChains.get(id) ?? Promise.resolve()).then(() => sendIfUnaccepted(id));
  reportChains.set(id, report);
  return report;
}

async function sendIfUnaccepted(id: string): Promise<void> {
  const entry = localStateCache.get(id);
  // Every report makes the tether push its group's desired state again, and the next sync would repeat it, so only a change is reported.
  if (!entry || Bun.deepEquals(acceptedByTether.get(id), entry)) {
    return;
  }

  const accepted = await reportInstallationStates({
    nodeId: await getNodeId(),
    states: [{ installationId: id, ...entry }],
  });
  if (accepted) {
    acceptedByTether.set(id, entry);
  }
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
