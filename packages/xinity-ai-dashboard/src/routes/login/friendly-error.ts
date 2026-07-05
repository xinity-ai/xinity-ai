export function friendlyError(raw: string | undefined): string {
  const originMisconfigured = `This dashboard is configured for a different URL than the one you used to reach it, so authentication cannot complete. Contact your administrator for the correct URL and how to access it.`;
  if (!raw) {
    return originMisconfigured;
  }
  if (/invalid origin|missing or null origin|cross-site navigation login blocked/i.test(raw)) {
    return originMisconfigured;
  }
  const match = raw.match(/^\[body\.(\w+)\]\s*(.+)/);
  if (!match) {
    return raw;
  }
  const [, field, detail] = match;
  const labels: Record<string, string> = { name: "name", email: "email address", password: "password" };
  const label = labels[field] ?? field;
  if (detail.includes("received undefined") || detail.includes("required")) {
    return `Please enter your ${label}.`;
  }
  return `Invalid ${label}: ${detail}`;
}
