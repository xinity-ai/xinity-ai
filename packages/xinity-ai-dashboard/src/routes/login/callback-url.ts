export function safeCallbackPath(raw: string | null): string {
  // Browsers read "/\" like "//", a link to another site.
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/";
  }
  return raw;
}
