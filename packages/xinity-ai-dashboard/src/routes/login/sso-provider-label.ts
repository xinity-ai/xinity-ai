export function ssoProviderLabel(providerId: string): string {
  if (!providerId) {
    return "your provider";
  }
  return providerId
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
