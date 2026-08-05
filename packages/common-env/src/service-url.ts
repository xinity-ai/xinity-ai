/**
 * Resolve an API path against a configured service base URL. The path replaces
 * whatever path the base carries, so a trailing slash or stray segment in an
 * operator-supplied `*_URL` cannot corrupt the endpoint: `http://host:2000/`
 * resolves to `http://host:2000/api/v1/stream`, not `//api/v1/stream`.
 *
 * Throws on a base that is not an absolute URL, which the `z.url()` on every
 * `*_URL` env var rules out before a service starts.
 */
export function serviceUrl(base: string, path: string): string {
  return new URL(path.startsWith("/") ? path : `/${path}`, base).href;
}
