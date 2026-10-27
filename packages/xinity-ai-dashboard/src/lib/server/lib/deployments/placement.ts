export type InstallationOwnership = { legacyId?: string | null; managedId?: string | null };

export type Placement = InstallationOwnership & { specifier: string };

export const ownedByLegacy = (legacyId: string): InstallationOwnership => ({ legacyId, managedId: null });

export function ownerOf({ legacyId, managedId }: InstallationOwnership): string {
  return legacyId ?? managedId ?? "";
}

export function requirementKey(entry: Placement): string {
  return `${ownerOf(entry)}:${entry.specifier}`;
}

export function firstFreePort(base: number, used: ReadonlySet<number>): number {
  let port = base;
  while (used.has(port)) {
    port++;
  }
  return port;
}
