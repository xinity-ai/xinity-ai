import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { pickReleaseAsset, verifySha256, type Release } from "../../src/lib/github.ts";
import { createTempDir, type TempDir } from "../helpers/temp-config.ts";

function makeRelease(assetNames: string[], tagName = "v0.1.0"): Release {
  return {
    tagName,
    name: tagName,
    assets: assetNames.map((name) => ({
      name,
      apiUrl: `https://api/${name}`,
      browserDownloadUrl: `https://browser/${name}`,
      size: 0,
    })),
  };
}

function withPlatform(platform: string, run: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

describe("github", () => {
  describe("pickReleaseAsset", () => {
    test("prefers tar.gz when both formats are present", () => {
      const release = makeRelease([
        "xinity-ai-gateway-linux-x64.zip",
        "xinity-ai-gateway-linux-x64.tar.gz",
      ]);
      expect(pickReleaseAsset(release, "gateway", "x64")).toBe("xinity-ai-gateway-linux-x64.tar.gz");
    });

    test("falls back to zip for pre-1.0.0 releases", () => {
      const release = makeRelease(["xinity-ai-gateway-linux-x64.zip"]);
      expect(pickReleaseAsset(release, "gateway", "x64")).toBe("xinity-ai-gateway-linux-x64.zip");
    });

    test("throws when neither format is present", () => {
      const release = makeRelease(["unrelated.txt"], "v0.5.0");
      expect(() => pickReleaseAsset(release, "gateway", "x64")).toThrow(/v0\.5\.0/);
    });

    test("returns db-migrations.tar.gz for db", () => {
      const release = makeRelease(["db-migrations.tar.gz"]);
      expect(pickReleaseAsset(release, "db")).toBe("db-migrations.tar.gz");
      expect(pickReleaseAsset(release, "db", "arm64")).toBe("db-migrations.tar.gz");
    });

    test("uses correct prefix per component", () => {
      const release = makeRelease([
        "xinity-cli-linux-x64.tar.gz",
        "xinity-infoserver-linux-x64.tar.gz",
        "xinity-ai-daemon-linux-x64.tar.gz",
        "xinity-ai-dashboard-linux-x64.tar.gz",
      ]);
      expect(pickReleaseAsset(release, "cli", "x64")).toBe("xinity-cli-linux-x64.tar.gz");
      expect(pickReleaseAsset(release, "infoserver", "x64")).toBe("xinity-infoserver-linux-x64.tar.gz");
      expect(pickReleaseAsset(release, "daemon", "x64")).toBe("xinity-ai-daemon-linux-x64.tar.gz");
      expect(pickReleaseAsset(release, "dashboard", "x64")).toBe("xinity-ai-dashboard-linux-x64.tar.gz");
    });

    test("only 'arm64' maps to arm64; everything else becomes x64", () => {
      const release = makeRelease([
        "xinity-ai-gateway-linux-x64.tar.gz",
        "xinity-ai-gateway-linux-arm64.tar.gz",
      ]);
      expect(pickReleaseAsset(release, "gateway", "x86_64")).toBe("xinity-ai-gateway-linux-x64.tar.gz");
      expect(pickReleaseAsset(release, "gateway", "aarch64")).toBe("xinity-ai-gateway-linux-x64.tar.gz");
      expect(pickReleaseAsset(release, "gateway", "arm64")).toBe("xinity-ai-gateway-linux-arm64.tar.gz");
    });

    test("uses process.arch when arch is omitted", () => {
      const expected = process.arch === "arm64" ? "arm64" : "x64";
      const release = makeRelease([`xinity-ai-gateway-linux-${expected}.tar.gz`]);
      expect(pickReleaseAsset(release, "gateway")).toBe(`xinity-ai-gateway-linux-${expected}.tar.gz`);
    });

    for (const [platform, label] of [["darwin", "macOS"], ["win32", "Windows"]] as const) {
      test(`points at newer releases when a Linux-only release is picked on ${label}`, () => {
        const release = makeRelease(["xinity-cli-linux-x64.tar.gz"], "v0.23.0");
        withPlatform(platform, () => {
          expect(() => pickReleaseAsset(release, "cli")).toThrow(
            `Release v0.23.0 has Linux builds only. ${label} builds are present in newer releases only.`,
          );
        });
      });
    }

    test("keeps the generic message when a release carries no CLI build at all", () => {
      const release = makeRelease(["unrelated.txt"], "v0.23.0");
      withPlatform("darwin", () => {
        expect(() => pickReleaseAsset(release, "cli")).toThrow(/^Neither xinity-cli-darwin-/);
      });
    });
  });

  describe("verifySha256", () => {
    let tmp: TempDir;

    beforeEach(() => {
      tmp = createTempDir("sha256-test");
    });

    afterEach(() => {
      tmp.cleanup();
    });

    test("returns true for matching hash", async () => {
      const content = "hello world";
      const filePath = tmp.write("test.txt", content);

      // Pre-computed SHA256 of "hello world"
      const expectedHash = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
      expect(await verifySha256(filePath, expectedHash)).toBe(true);
    });

    test("returns false for mismatched hash", async () => {
      const filePath = tmp.write("test.txt", "hello world");
      const wrongHash = "0000000000000000000000000000000000000000000000000000000000000000";
      expect(await verifySha256(filePath, wrongHash)).toBe(false);
    });

  });
});
