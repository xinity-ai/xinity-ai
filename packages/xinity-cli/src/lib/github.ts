/**
 * GitHub Releases API integration: version checking, asset downloading, and checksum verification.
 *
 * Supports private repos via a configurable token (githubToken in CLI config).
 * Falls back to `gh auth token` if the GitHub CLI is authenticated.
 */
import { join } from "path";
import { loadConfig } from "./config.ts";
import { createLocalHost } from "./host.ts";

const DEFAULT_PROJECT_URL = "https://github.com/xinity-ai/xinity-ai";

export interface ReleaseAsset {
  name: string;
  /** API URL for downloading (works with auth for private repos). */
  apiUrl: string;
  /** Browser URL (only works for public repos). */
  browserDownloadUrl: string;
  size: number;
}

export interface Release {
  tagName: string;
  name: string;
  assets: ReleaseAsset[];
}

/** Extract "owner/repo" from a GitHub URL and return the API base. */
function getApiBase(): string {
  const url = loadConfig().githubProjectUrl ?? DEFAULT_PROJECT_URL;
  const match = url.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match) throw new Error(`Invalid GitHub project URL: ${url}`);
  return `https://api.github.com/repos/${match[1]}`;
}

/**
 * Resolve a GitHub token for API authentication.
 * Priority: config > `gh auth token` > none.
 */
async function resolveToken(): Promise<string | undefined> {
  const config = loadConfig();
  if (config.githubToken) return config.githubToken;

  // Try the GitHub CLI (always a local check)
  try {
    const local = createLocalHost();
    const result = await local.run(["gh", "auth", "token"]);
    if (result.ok && result.output) return result.output;
  } catch { /* gh not installed or not authenticated */ }

  return undefined;
}

/** Build common headers for GitHub API requests. */
async function apiHeaders(accept = "application/vnd.github+json"): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: accept };
  const token = await resolveToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Fetch a release by version tag (or "latest"). */
export async function fetchRelease(version: string): Promise<Release> {
  const base = getApiBase();
  const url =
    version === "latest"
      ? `${base}/releases/latest`
      : `${base}/releases/tags/${version}`;

  const res = await fetch(url, { headers: await apiHeaders() });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 404) {
      throw new Error(
        `Release not found. If this is a private repo, set a token via: xinity configure githubToken`,
      );
    }
    throw new Error(
      `GitHub API ${res.status}: ${res.statusText}${body ? `: ${body}` : ""}`,
    );
  }

  const data = (await res.json()) as {
    tag_name: string;
    name: string;
    assets: { name: string; url: string; browser_download_url: string; size: number }[];
  };

  return {
    tagName: data.tag_name,
    name: data.name,
    assets: data.assets.map((a) => ({
      name: a.name,
      apiUrl: a.url,
      browserDownloadUrl: a.browser_download_url,
      size: a.size,
    })),
  };
}

/**
 * Download a release asset to `destDir`, returning the full file path.
 *
 * For private repos the browser_download_url returns 404, so we use the
 * API URL with `Accept: application/octet-stream` which triggers a redirect
 * to a pre-signed S3 URL.
 */
export async function downloadAsset(
  asset: ReleaseAsset,
  destDir: string,
): Promise<string> {
  // Use the API URL with octet-stream accept (works for both public and private repos)
  const headers = await apiHeaders("application/octet-stream");
  const res = await fetch(asset.apiUrl, { headers });

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const destPath = join(destDir, asset.name);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Bun.write(destPath, bytes);
  return destPath;
}

/** Fetch and parse SHASUMS256.txt from a release into a Map<filename, hash>. */
export async function fetchChecksums(
  release: Release,
): Promise<Map<string, string>> {
  const asset = release.assets.find((a) => a.name === "SHASUMS256.txt");
  if (!asset) return new Map();

  const headers = await apiHeaders("application/octet-stream");
  const res = await fetch(asset.apiUrl, { headers });
  if (!res.ok) return new Map();

  const text = await res.text();
  const checksums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match) checksums.set(match[2]!.trim(), match[1]!);
  }
  return checksums;
}

/** Verify a file's SHA256 hash. Returns true if it matches. */
export async function verifySha256(
  filePath: string,
  expectedHash: string,
): Promise<boolean> {
  const file = Bun.file(filePath);
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = file.stream();

  for await (const chunk of stream) {
    hasher.update(chunk);
  }

  return hasher.digest("hex") === expectedHash;
}

/**
 * Resolve the direct download URL for a release asset.
 *
 * For private repos, the GitHub API URL redirects to a pre-signed S3 URL.
 * This function resolves that redirect locally (where the auth token is
 * available) and returns a URL that works without authentication, suitable
 * for passing to curl on a remote machine.
 */
export async function resolveDirectUrl(asset: ReleaseAsset): Promise<string> {
  const headers = await apiHeaders("application/octet-stream");
  const res = await fetch(asset.apiUrl, { headers, redirect: "manual" });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (location) return location;
  }

  // Public repo served the content directly, use the browser URL instead
  if (res.ok || res.status === 200) {
    return asset.browserDownloadUrl;
  }

  throw new Error(`Failed to resolve download URL: ${res.status} ${res.statusText}`);
}

/** Determine the expected asset filename for a component on the given platform. */
export function getAssetName(component: string, arch?: string): string {
  if (component === "dashboard") {
    return "xinity-ai-dashboard.tar.gz";
  }

  const resolved = (arch ?? process.arch) === "arm64" ? "arm64" : "x64";

  if (component === "cli") {
    return `xinity-cli-linux-${resolved}.zip`;
  }

  if (component === "db") {
    return "db-migrations.tar.gz";
  }

  if (component === "infoserver") {
    return `xinity-infoserver-linux-${resolved}.zip`;
  }

  return `xinity-ai-${component}-linux-${resolved}.zip`;
}
