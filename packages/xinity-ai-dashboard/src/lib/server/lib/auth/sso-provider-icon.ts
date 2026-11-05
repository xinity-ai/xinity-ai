import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "auth.sso-provider-icon" });

const CACHE_TTL_MS = { found: 24 * 60 * 60 * 1000, missing: 60 * 60 * 1000 };
const FETCH_TIMEOUT_MS = 3_000;

const iconCache = new Map<string, { iconUrl?: string; expiresAt: number }>();
const pendingLookups = new Set<string>();

// Never waits on the identity provider, because it runs on every login page load. An unknown or
// expired icon is looked up in the background and shows from the next call on.
export function cachedIssuerIconUrl(issuer: string): string | undefined {
  const cached = iconCache.get(issuer);
  if (!cached || cached.expiresAt <= Date.now()) {
    void refreshIssuerIcon(issuer);
  }
  return cached?.iconUrl;
}

async function refreshIssuerIcon(issuer: string): Promise<void> {
  if (pendingLookups.has(issuer)) {
    return;
  }
  pendingLookups.add(issuer);
  let iconUrl: string | undefined;
  try {
    iconUrl = await findIssuerIconUrl(issuer);
  } catch (err) {
    log.debug({ err, issuer }, "SSO provider icon lookup failed");
  } finally {
    iconCache.set(issuer, { iconUrl, expiresAt: Date.now() + CACHE_TTL_MS[iconUrl ? "found" : "missing"] });
    pendingLookups.delete(issuer);
  }
}

async function findIssuerIconUrl(issuer: string): Promise<string | undefined> {
  const issuerUrl = URL.parse(issuer);
  if (issuerUrl?.protocol !== "https:") {
    return undefined;
  }
  for (const page of iconPages(issuerUrl)) {
    const iconUrl = await declaredIconUrl(page);
    if (iconUrl && await servesImage(iconUrl)) {
      return iconUrl;
    }
  }
  const favicon = new URL("/favicon.ico", issuerUrl.origin).href;
  return await servesImage(favicon) ? favicon : undefined;
}

type KnownIdentityProvider = {
  isIssuer: (issuerUrl: URL) => boolean;
  iconPage: (issuerUrl: URL) => URL;
};

const KNOWN_IDENTITY_PROVIDERS: Record<string, KnownIdentityProvider> = {
  // The issuer is a realm (`/realms/<name>`, behind `/auth` before Keycloak 17). Its account page
  // carries the realm's own theme, so a branded realm shows its own icon.
  keycloak: {
    isIssuer: (issuerUrl) => /\/realms\/[^/]+\/?$/.test(issuerUrl.pathname),
    iconPage: (issuerUrl) => new URL("account", `${issuerUrl.href.replace(/\/$/, "")}/`),
  },
};

function iconPages(issuerUrl: URL): URL[] {
  const knownProviderPages = Object.values(KNOWN_IDENTITY_PROVIDERS)
    .filter((provider) => provider.isIssuer(issuerUrl))
    .map((provider) => provider.iconPage(issuerUrl));
  return [issuerUrl, ...knownProviderPages, new URL("/", issuerUrl.origin)];
}

async function declaredIconUrl(page: URL): Promise<string | undefined> {
  const response = await fetchWithTimeout(page);
  if (!response.ok || !hasContentType(response, "text/html")) {
    await response.body?.cancel();
    return undefined;
  }
  let href: string | undefined;
  await new HTMLRewriter()
    .on("link[rel][href]", {
      element(link) {
        const relTokens = link.getAttribute("rel")?.toLowerCase().split(/\s+/) ?? [];
        if (!href && relTokens.includes("icon")) {
          href = link.getAttribute("href") ?? undefined;
        }
      },
    })
    .transform(response)
    .arrayBuffer();
  const iconUrl = href ? URL.parse(href, response.url) : null;
  // The login page's CSP only allows https images.
  return iconUrl?.protocol === "https:" ? iconUrl.href : undefined;
}

async function servesImage(url: string): Promise<boolean> {
  const response = await fetchWithTimeout(url);
  await response.body?.cancel();
  return response.ok && hasContentType(response, "image/");
}

function fetchWithTimeout(url: URL | string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function hasContentType(response: Response, prefix: string): boolean {
  return response.headers.get("content-type")?.startsWith(prefix) ?? false;
}
