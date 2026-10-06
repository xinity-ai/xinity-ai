export type Placement = { deploymentId: string; specifier: string };

export function requirementKey(entry: Placement): string {
  return `${entry.deploymentId}:${entry.specifier}`;
}
