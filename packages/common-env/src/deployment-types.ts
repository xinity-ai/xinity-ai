// Each type names the table holding its rows, deployment_<type>.
export const DEPLOYMENT_TYPES = ["legacy", "managed", "canary"] as const;
export type DeploymentType = (typeof DEPLOYMENT_TYPES)[number];
