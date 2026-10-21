function toHostname(entry: string): string {
  try {
    return new URL(entry.includes("://") ? entry : `https://${entry}`).hostname.toLowerCase();
  } catch {
    return entry.toLowerCase();
  }
}

export function providerEmailDomains(domain: string): string[] {
  return domain
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(toHostname);
}

export function isEmailInProviderDomain(email: string, domain: string): boolean {
  const emailDomain = email.split("@")[1]?.trim().toLowerCase();
  if (!emailDomain) {
    return false;
  }
  return providerEmailDomains(domain).some(
    (allowed) => emailDomain === allowed || emailDomain.endsWith(`.${allowed}`),
  );
}
