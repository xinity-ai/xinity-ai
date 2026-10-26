import { homedir } from "node:os";
import { join } from "node:path";
import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { getTrustedRoot } from "@sigstore/tuf";
import { Verifier, toSignedEntity, toTrustMaterial } from "@sigstore/verify";
import seeds from "@sigstore/tuf/seeds.json";
import { IS_WINDOWS } from "../core/platform.ts";

const TUF_MIRROR = "https://tuf-repo-cdn.sigstore.dev";
const TUF_TIMEOUT_MS = 5000;
const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

export type TrustSource = "online" | "cache" | "embedded";

function tufCachePath(): string {
  const base = IS_WINDOWS
    ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
    : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  return join(base, "xinity", "sigstore");
}

export function embeddedTrustedRoot(): TrustedRoot {
  const encoded = seeds[TUF_MIRROR].targets["trusted_root.json"];
  return TrustedRoot.fromJSON(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
}

// Every fallback yields an older but genuine trust root, which an attacker
// could force anyway by blocking the network. So any failure falls through,
// including expired metadata on a wrong clock or an unwritable cache.
export async function loadTrustedRoot(): Promise<{ root: TrustedRoot; source: TrustSource }> {
  const cachePath = tufCachePath();
  const loaders: [TrustSource, () => Promise<TrustedRoot>][] = [
    ["online", () => getTrustedRoot({ cachePath, timeout: TUF_TIMEOUT_MS, retry: false })],
    ["cache", () => getTrustedRoot({ cachePath, forceCache: true, timeout: TUF_TIMEOUT_MS, retry: false })],
  ];
  for (const [source, load] of loaders) {
    try {
      return { root: await load(), source };
    } catch {
      continue;
    }
  }
  return { root: embeddedTrustedRoot(), source: "embedded" };
}

let trustedRootPromise: ReturnType<typeof loadTrustedRoot> | undefined;

export function trustedRoot(): ReturnType<typeof loadTrustedRoot> {
  return trustedRootPromise ??= loadTrustedRoot();
}

function releaseSignerIdentity(repoSlug: string): string {
  return `https://github.com/${repoSlug}/.github/workflows/release.yml@refs/heads/main`;
}

export function verifyChecksumSignature(
  checksums: Buffer,
  bundleJson: unknown,
  repoSlug: string,
  root: TrustedRoot,
): void {
  const verifier = new Verifier(toTrustMaterial(root));
  const signer = verifier.verify(toSignedEntity(bundleFromJSON(bundleJson), checksums), {
    extensions: { issuer: GITHUB_ACTIONS_ISSUER },
  });
  const expected = releaseSignerIdentity(repoSlug);
  // GitHub owner and repository names are case-insensitive, the configured project URL may differ in case.
  if (signer.identity?.subjectAlternativeName?.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`signed by ${signer.identity?.subjectAlternativeName ?? "an unknown identity"}, expected ${expected}`);
  }
}
