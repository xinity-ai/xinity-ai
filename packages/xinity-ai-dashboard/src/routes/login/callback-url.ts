const SAME_SITE = "http://same-site.invalid";

// Browsers drop tabs and newlines and read "\" as "/", so only the parsed URL shows where the redirect lands.
export function safeCallbackPath(raw: string | null): string {
  if (!raw?.startsWith("/")) {
    return "/";
  }
  const target = new URL(raw, SAME_SITE);
  if (target.origin !== SAME_SITE) {
    return "/";
  }
  return target.pathname + target.search + target.hash;
}
