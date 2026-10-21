const ACCOUNT_NOT_LINKED = "account not linked";

const ssoErrors: Record<string, string> = {
  "signup disabled":
    "Sign-up via SSO is currently disabled. Contact an administrator for access.",
  "unable to create user":
    "Your account could not be created. Please try again, and contact an administrator if it keeps failing.",
  "unable to link account":
    "Your existing account could not be linked to this SSO provider. Please try again, and contact an administrator if it keeps failing.",
  "internal server error":
    "Something went wrong while signing you in. Please try again, and contact an administrator if it keeps failing.",
  "invalid state":
    "The sign-in session expired or was tampered with. Please try again.",
  "invalid request":
    "The sign-in request was not valid. Please start again from the login page.",
  "invalid provider":
    "The SSO provider could not be found or is misconfigured. Contact an administrator of the organization that set it up.",
  "discovery failed":
    "Could not reach the SSO provider. Please try again later or contact an administrator.",
  "provider domain has not been verified":
    "Sign-in with this SSO provider is not available yet because its domain has not been verified. An administrator of the organization that set it up needs to complete domain verification.",
  "this account has been suspended":
    "This account has been suspended. Contact an instance administrator if you think this is a mistake.",
};

function normalizeSsoError(raw: string): string {
  return raw.replace(/[+_]/g, " ").trim().toLowerCase();
}

export function isAccountNotLinked(raw: string | undefined): boolean {
  return !!raw && normalizeSsoError(raw) === ACCOUNT_NOT_LINKED;
}

function accountNotLinkedMessage(providerDomains: string[]): string {
  const allowed = providerDomains.length > 0
    ? `addresses at ${providerDomains.join(" or ")} (including subdomains)`
    : "addresses within this provider's verified domain";
  return `An account with this email already exists, but it could not be linked to this SSO provider. Linking only works for ${allowed}, and only if the existing account's email is verified. If your address is in that domain, ask an instance administrator to mark your email as verified. Otherwise, sign in with the method you originally used.`;
}

export function friendlySsoError(raw: string | undefined, providerDomains: string[] = []): string | null {
  if (!raw) {
    return null;
  }
  const normalized = normalizeSsoError(raw);
  if (normalized === ACCOUNT_NOT_LINKED) {
    return accountNotLinkedMessage(providerDomains);
  }
  return ssoErrors[normalized] ?? raw.replace(/\+/g, " ");
}

const ORIGIN_MISCONFIGURED =
  "This dashboard is configured for a different URL than the one you used to reach it, so authentication cannot complete. Contact your administrator for the correct URL and how to access it.";

const fieldLabels: Record<string, string> = {
  name: "name",
  email: "email address",
  password: "password",
};

export function friendlyError(raw: string | undefined): string {
  if (!raw) {
    return ORIGIN_MISCONFIGURED;
  }
  if (/invalid origin|missing or null origin|cross-site navigation login blocked/i.test(raw)) {
    return ORIGIN_MISCONFIGURED;
  }
  const validationMatch = raw.match(/^\[body\.(\w+)\]\s*(.+)/);
  if (!validationMatch) {
    return raw;
  }
  const [, field, detail] = validationMatch;
  const label = fieldLabels[field] ?? field;
  if (detail.includes("received undefined") || detail.includes("required")) {
    return `Please enter your ${label}.`;
  }
  return `Invalid ${label}: ${detail}`;
}
