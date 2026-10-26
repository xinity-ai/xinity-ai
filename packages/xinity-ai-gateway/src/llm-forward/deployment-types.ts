import type { Deployment, lifecycleStateEnum } from "common-db";
import type { DeploymentType } from "common-env";
import { canaryDeployment, type CanaryPayload } from "./canary-deployment";
import { legacyDeployment, type LegacyPayload } from "./legacy-deployment";
import { managedDeployment, type ManagedPayload } from "./managed-deployment";
import type { ModelLookup } from "./model-data";

export type ModelDescription = {
  status: typeof lifecycleStateEnum.enumValues[number] | null;
  canary: boolean;
  maxModelLen: number;
};

export type GatewayDeploymentType<Payload> = {
  load: (entry: Deployment) => Promise<Payload | undefined>;
  resolve: (payload: Payload, publicSpecifier: string, prefixHashes?: string[]) => Promise<ModelLookup>;
  /** Keyed by entry id. Entries left out are not listed. */
  describe: (entries: Deployment[]) => Promise<Map<string, ModelDescription>>;
};

// Kept in the cache between requests, so it holds plain JSON.
type Payloads = { legacy: LegacyPayload; managed: ManagedPayload; canary: CanaryPayload };

type LoadedOf<T extends DeploymentType> = { [K in T]: { type: K; payload: Payloads[K] } }[T];
export type LoadedDeployment = LoadedOf<DeploymentType>;

export const GATEWAY_DEPLOYMENT_TYPES: { [T in DeploymentType]: GatewayDeploymentType<Payloads[T]> } = {
  legacy: legacyDeployment,
  managed: managedDeployment,
  canary: canaryDeployment,
};

// The two helpers carry the type through a type parameter, which ties each handler to its own payload.
export async function loadOfType<T extends DeploymentType>(type: T, entry: Deployment): Promise<LoadedOf<T> | undefined> {
  const payload = await GATEWAY_DEPLOYMENT_TYPES[type].load(entry);
  return payload && ({ type, payload } as LoadedOf<T>);
}

export function resolveLoaded<T extends DeploymentType>(deployment: { type: T; payload: Payloads[T] }, publicSpecifier: string, prefixHashes?: string[]): Promise<ModelLookup> {
  return GATEWAY_DEPLOYMENT_TYPES[deployment.type].resolve(deployment.payload, publicSpecifier, prefixHashes);
}
