import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Release } from "../../../src/lib/up/github.ts";
import { createTempDir, redirectXdgConfigHome, type TempDir } from "../../helpers/temp-config.ts";

const failingTufModes = new Set<"online" | "cache">();
const tufRootSentinel = { sentinel: true };

mock.module("@sigstore/tuf", () => ({
  getTrustedRoot: async (options: { forceCache?: boolean }) => {
    if (failingTufModes.has(options.forceCache ? "cache" : "online")) {
      throw new Error("simulated TUF failure");
    }
    return tufRootSentinel;
  },
}));

const { embeddedTrustedRoot, loadTrustedRoot, verifyChecksumSignature } = await import(
  "../../../src/lib/up/release-signature.ts"
);
const { fetchChecksums } = await import("../../../src/lib/up/github.ts");
const { saveConfig } = await import("../../../src/lib/config/config.ts");

// Signed by the release workflow on main of this repository in a real GitHub Actions run.
const SIGNING_REPO = "JAAvander/xinity-signing-test";
const FIXTURE_DIR = join(import.meta.dir, "../../fixtures/signed-release");
const checksums = readFileSync(join(FIXTURE_DIR, "SHASUMS256.txt"));
const bundleText = readFileSync(join(FIXTURE_DIR, "SHASUMS256.txt.sigstore.json"), "utf8");
const bundle = JSON.parse(bundleText);

describe("verifyChecksumSignature", () => {
  const root = embeddedTrustedRoot();

  test("accepts checksums signed by the repository's release workflow", () => {
    expect(() => verifyChecksumSignature(checksums, bundle, SIGNING_REPO, root)).not.toThrow();
  });

  test("matches the repository name case-insensitively", () => {
    expect(() => verifyChecksumSignature(checksums, bundle, SIGNING_REPO.toLowerCase(), root)).not.toThrow();
  });

  test("rejects modified checksums", () => {
    const tampered = Buffer.concat([checksums, Buffer.from("tampered\n")]);
    expect(() => verifyChecksumSignature(tampered, bundle, SIGNING_REPO, root)).toThrow();
  });

  test("rejects a signature from another repository's workflow", () => {
    expect(() => verifyChecksumSignature(checksums, bundle, "xinity-ai/xinity-ai", root)).toThrow(
      /expected https:\/\/github\.com\/xinity-ai\/xinity-ai\//,
    );
  });
});

describe("loadTrustedRoot", () => {
  afterEach(() => failingTufModes.clear());

  test("uses the online update when it succeeds", async () => {
    const { root, source } = await loadTrustedRoot();
    expect(source).toBe("online");
    expect(root).toBe(tufRootSentinel as never);
  });

  test("falls back to the cache when the update fails", async () => {
    failingTufModes.add("online");
    expect((await loadTrustedRoot()).source).toBe("cache");
  });

  test("falls back to the embedded root when the cache fails too", async () => {
    failingTufModes.add("online");
    failingTufModes.add("cache");
    const { root, source } = await loadTrustedRoot();
    expect(source).toBe("embedded");
    expect(root.certificateAuthorities.length).toBeGreaterThan(0);
  });
});

describe("fetchChecksums", () => {
  let tmp: TempDir;
  let restoreXdg: () => void;
  let assets: Record<string, Buffer | string>;

  function release(tagName: string): Release {
    return {
      tagName,
      name: tagName,
      assets: Object.keys(assets).map((name) => ({
        name,
        apiUrl: `https://api.test/${name}`,
        browserDownloadUrl: `https://browser.test/${name}`,
        size: 0,
      })),
    };
  }

  beforeAll(() => {
    tmp = createTempDir();
    restoreXdg = redirectXdgConfigHome(tmp);
    saveConfig({ githubProjectUrl: `https://github.com/${SIGNING_REPO}`, githubToken: "test-token" });
    failingTufModes.add("online");
    failingTufModes.add("cache");
    spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const name = String(input).split("/").pop()!;
      const body = assets[name];
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    }) as typeof fetch);
  });

  afterAll(() => {
    mock.restore();
    failingTufModes.clear();
    restoreXdg();
    tmp.cleanup();
  });

  test("verifies the signature of a signed release", async () => {
    assets = { "SHASUMS256.txt": checksums, "SHASUMS256.txt.sigstore.json": bundleText };
    const result = await fetchChecksums(release("v0.27.0"));
    expect(result?.signature).toBe("embedded");
    expect(result?.hashes.get("app-linux-x64.tar.gz")).toBe(
      "dace82371525b81729329d6d579bc783ef95cd6a25f635cf1efc594862dbe52c",
    );
  });

  test("refuses a signed release whose checksums were modified", async () => {
    assets = { "SHASUMS256.txt": `${checksums}tampered\n`, "SHASUMS256.txt.sigstore.json": bundleText };
    await expect(fetchChecksums(release("v0.27.0"))).rejects.toThrow(/Signature of SHASUMS256\.txt is invalid/);
  });

  test("refuses a signed release without a signature", async () => {
    assets = { "SHASUMS256.txt": checksums };
    await expect(fetchChecksums(release("v0.26.4"))).rejects.toThrow(/has no SHASUMS256\.txt\.sigstore\.json/);
  });

  test("refuses a signed release without checksums", async () => {
    assets = {};
    await expect(fetchChecksums(release("v0.27.0"))).rejects.toThrow(/has no SHASUMS256\.txt$/);
  });

  test("accepts unsigned checksums from a release that predates signing", async () => {
    assets = { "SHASUMS256.txt": checksums };
    const result = await fetchChecksums(release("v0.26.3"));
    expect(result?.signature).toBe("unsigned");
    expect(result?.hashes.size).toBe(2);
  });

  test("returns null for an older release without checksums", async () => {
    assets = {};
    expect(await fetchChecksums(release("v0.26.3"))).toBeNull();
  });
});
