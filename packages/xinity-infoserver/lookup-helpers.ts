/**
 * Catalog-resolution descriptor and the row-shape helpers that build it. Two paths exist:
 * canonical (catalog primary key) and legacy (provider-string reverse lookup, ambiguous when
 * two catalog entries share a provider string).
 */
export type ModelLookup =
  | { kind: "canonical"; specifier: string }
  | { kind: "legacy"; providerModel: string };

export function lookupKey(lookup: ModelLookup): string {
  return lookup.kind === "canonical" ? lookup.specifier : lookup.providerModel;
}

export function deploymentLookup(d: { specifier?: string | null; modelSpecifier: string }): ModelLookup;
export function deploymentLookup(d: { specifier?: string | null; modelSpecifier?: string | null }): ModelLookup | null;
export function deploymentLookup(d: { specifier?: string | null; modelSpecifier?: string | null }): ModelLookup | null {
  if (d.specifier) return { kind: "canonical", specifier: d.specifier };
  if (d.modelSpecifier) return { kind: "legacy", providerModel: d.modelSpecifier };
  return null;
}

export function deploymentEarlyLookup(d: { earlySpecifier?: string | null; earlyModelSpecifier?: string | null }): ModelLookup | null {
  if (d.earlySpecifier) return { kind: "canonical", specifier: d.earlySpecifier };
  if (d.earlyModelSpecifier) return { kind: "legacy", providerModel: d.earlyModelSpecifier };
  return null;
}

export function installationLookup(i: { specifier?: string | null; model: string }): ModelLookup {
  return i.specifier ? { kind: "canonical", specifier: i.specifier } : { kind: "legacy", providerModel: i.model };
}

export function installationKey(i: { specifier?: string | null; model: string }): string {
  return lookupKey(installationLookup(i));
}
