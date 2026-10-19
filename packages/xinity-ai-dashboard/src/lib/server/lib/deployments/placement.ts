export type Placement = { deploymentId: string; specifier: string };

export function requirementKey(entry: Placement): string {
  return `${entry.deploymentId}:${entry.specifier}`;
}

export function firstFreePort(base: number, used: ReadonlySet<number>): number {
  let port = base;
  while (used.has(port)) {
    port++;
  }
  return port;
}
