import type { Deployment, lifecycleStateEnum } from "common-db";
import type { DeploymentType } from "common-env";
import { legacyDeployment, type LegacyPayload } from "./legacy-deployment";
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
type Payloads = { legacy: LegacyPayload };

export type LoadedDeployment = { [T in DeploymentType]: { type: T; payload: Payloads[T] } }[DeploymentType];

export const GATEWAY_DEPLOYMENT_TYPES: { [T in DeploymentType]: GatewayDeploymentType<Payloads[T]> } = {
  legacy: legacyDeployment,
};
