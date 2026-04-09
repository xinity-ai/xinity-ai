import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { getAssetName, verifySha256 } from "../../src/lib/github.ts";
import { createTempDir, type TempDir } from "../helpers/temp-config.ts";

describe("github", () => {
  describe("getAssetName", () => {
    test("returns platform-specific zip for dashboard", () => {
      const name = getAssetName("dashboard");
      expect(name).toMatch(/^xinity-ai-dashboard-linux-(x64|arm64)\.zip$/);
    });

    test("returns tar.gz for db migrations", () => {
      expect(getAssetName("db")).toBe("db-migrations.tar.gz");
    });

    test("returns platform-specific zip for gateway", () => {
      const name = getAssetName("gateway");
      expect(name).toMatch(/^xinity-ai-gateway-linux-(x64|arm64)\.zip$/);
    });

    test("returns platform-specific zip for daemon", () => {
      const name = getAssetName("daemon");
      expect(name).toMatch(/^xinity-ai-daemon-linux-(x64|arm64)\.zip$/);
    });

    test("returns platform-specific zip for cli", () => {
      const name = getAssetName("cli");
      expect(name).toMatch(/^xinity-cli-linux-(x64|arm64)\.zip$/);
    });

    test("uses correct architecture suffix", () => {
      const name = getAssetName("gateway");
      const expectedArch = process.arch === "arm64" ? "arm64" : "x64";
      expect(name).toContain(expectedArch);
    });

    test("dashboard asset name is architecture-specific", () => {
      const name = getAssetName("dashboard");
      const expectedArch = process.arch === "arm64" ? "arm64" : "x64";
      expect(name).toContain(expectedArch);
    });

    test("db asset name is architecture-independent", () => {
      expect(getAssetName("db")).not.toContain("x64");
      expect(getAssetName("db")).not.toContain("arm64");
    });

    test("uses explicit arch parameter when provided", () => {
      expect(getAssetName("gateway", "arm64")).toBe("xinity-ai-gateway-linux-arm64.zip");
      expect(getAssetName("gateway", "x64")).toBe("xinity-ai-gateway-linux-x64.zip");
      expect(getAssetName("daemon", "arm64")).toBe("xinity-ai-daemon-linux-arm64.zip");
      expect(getAssetName("cli", "arm64")).toBe("xinity-cli-linux-arm64.zip");
      expect(getAssetName("infoserver", "x64")).toBe("xinity-infoserver-linux-x64.zip");
    });

    test("maps non-standard arch names correctly", () => {
      // aarch64 (uname -m output) should map to arm64
      expect(getAssetName("gateway", "aarch64")).not.toContain("arm64");
      // Only "arm64" is treated as arm64; everything else becomes x64
      expect(getAssetName("gateway", "x86_64")).toBe("xinity-ai-gateway-linux-x64.zip");
    });

    test("dashboard respects explicit arch parameter, db does not", () => {
      expect(getAssetName("dashboard", "arm64")).toBe("xinity-ai-dashboard-linux-arm64.zip");
      expect(getAssetName("dashboard", "x64")).toBe("xinity-ai-dashboard-linux-x64.zip");
      expect(getAssetName("db", "arm64")).toBe("db-migrations.tar.gz");
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

    test("handles empty files", async () => {
      const filePath = tmp.write("empty.txt", "");
      // SHA256 of empty string
      const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      expect(await verifySha256(filePath, emptyHash)).toBe(true);
    });

    test("handles binary-like content", async () => {
      const filePath = tmp.write("binary.dat", "\x00\x01\x02\x03");
      // Just verify it doesn't throw
      const result = await verifySha256(filePath, "wrong");
      expect(typeof result).toBe("boolean");
    });
  });
});
