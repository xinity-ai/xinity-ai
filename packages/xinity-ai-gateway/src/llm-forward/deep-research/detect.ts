export const DEEP_RESEARCH_SUFFIX = "-deep-research";

export function isDeepResearchRequest(model: string): boolean {
  return model.endsWith(DEEP_RESEARCH_SUFFIX);
}

export function stripDeepResearchSuffix(model: string): string {
  return model.slice(0, -DEEP_RESEARCH_SUFFIX.length);
}
