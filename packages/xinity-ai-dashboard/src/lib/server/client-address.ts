/**
 * Single source of truth for the client IP.
 *
 * The Bun adapter resolves the address from the raw connection plus the
 * HTTP_IP_HEADER / HTTP_XFF_DEPTH / HTTP_TRUSTED_PROXIES settings, so
 * `event.getClientAddress()` is the only place a forwarded header is trusted.
 * The request hook stamps that result onto CLIENT_ADDRESS_HEADER, overwriting
 * anything the client sent, so downstream consumers that only see a Request
 * (Better Auth) read the same value instead of re-parsing x-forwarded-for.
 */
export const CLIENT_ADDRESS_HEADER = "x-client-address";

export function stampClientAddress(request: Request, address: string): void {
  if (address) {
    request.headers.set(CLIENT_ADDRESS_HEADER, address);
  } else {
    request.headers.delete(CLIENT_ADDRESS_HEADER);
  }
}

export function readClientAddress(headers: Headers | null | undefined): string | null {
  return headers?.get(CLIENT_ADDRESS_HEADER) || null;
}
