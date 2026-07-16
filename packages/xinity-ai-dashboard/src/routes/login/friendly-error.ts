const ssoErrors: Record<string, string> = {
  "account not linked":
    "An account with this email already exists but is not linked to this SSO provider. Sign in with your original method or contact an administrator.",
  "signup disabled":
    "Sign-up via SSO is currently disabled. Contact an administrator for access.",
  invalid_state:
    "The sign-in session expired or was tampered with. Please try again.",
  invalid_provider:
    "The SSO provider could not be found or is misconfigured. Contact an administrator.",
  discovery_failed:
    "Could not reach the SSO provider. Please try again later or contact an administrator.",
};

export function friendlySsoError(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.replace(/\+/g, " ");
  return ssoErrors[normalized] ?? normalized;
}

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
