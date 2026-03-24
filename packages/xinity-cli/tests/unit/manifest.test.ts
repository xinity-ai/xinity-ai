import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { createTempDir, type TempDir } from "../helpers/temp-config.ts";
import type { Manifest, ComponentEntry } from "../../src/lib/manifest.ts";
import { makeComponentEntry, makeManifest } from "../helpers/fixtures.ts";

/**
 * Manifest logic tests.
 *
 * The manifest module reads from /opt/xinity/manifest.json and writes
 * via withElevation (sudo). We test the read/parse logic directly against
 * temp files, mirroring the same code patterns.
 */
describe("manifest", () => {
  let tmp: TempDir;
  let manifestPath: string;

  /** Mirror readManifest() logic against temp path. */
  function readManifest(): Manifest {
    if (!existsSync(manifestPath)) return { components: {} };
    try {
      return JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
    } catch {
      return { components: {} };
    }
  }

  /** Mirror getInstalledVersion() logic. */
  function getInstalledVersion(component: string): string | null {
    return readManifest().components[component]?.version ?? null;
  }

  beforeEach(() => {
    tmp = createTempDir("manifest-test");
    manifestPath = join(tmp.path, "manifest.json");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  describe("readManifest", () => {
    test("returns empty manifest when file does not exist", () => {
      const manifest = readManifest();
      expect(manifest).toEqual({ components: {} });
    });

    test("parses valid manifest", () => {
      const data = makeManifest({
        gateway: makeComponentEntry({ version: "v1.0.0" }),
      });
      writeFileSync(manifestPath, JSON.stringify(data));

      const manifest = readManifest();
      expect(manifest.components.gateway?.version).toBe("v1.0.0");
    });

    test("returns empty manifest for invalid JSON", () => {
      writeFileSync(manifestPath, "corrupted{{{");

      const manifest = readManifest();
      expect(manifest).toEqual({ components: {} });
    });

    test("handles manifest with multiple components", () => {
      const data = makeManifest({
        gateway: makeComponentEntry({
          version: "v1.0.0",
          binaryPath: "/opt/xinity/bin/xinity-ai-gateway",
          unitName: "xinity-ai-gateway.service",
        }),
        dashboard: makeComponentEntry({
          version: "v1.0.1",
          binaryPath: "/opt/xinity/dashboard",
          unitName: "xinity-ai-dashboard.service",
        }),
      });
      writeFileSync(manifestPath, JSON.stringify(data));

      const manifest = readManifest();
      expect(manifest.components.gateway?.version).toBe("v1.0.0");
      expect(manifest.components.dashboard?.version).toBe("v1.0.1");
    });
  });

  describe("getInstalledVersion", () => {
    test("returns null for uninstalled component", () => {
      expect(getInstalledVersion("gateway")).toBeNull();
    });

    test("returns version for installed component", () => {
      const data = makeManifest({
        gateway: makeComponentEntry({ version: "v2.0.0" }),
      });
      writeFileSync(manifestPath, JSON.stringify(data));

      expect(getInstalledVersion("gateway")).toBe("v2.0.0");
    });

    test("returns null for component not in manifest", () => {
      const data = makeManifest({
        gateway: makeComponentEntry({ version: "v1.0.0" }),
      });
      writeFileSync(manifestPath, JSON.stringify(data));

      expect(getInstalledVersion("daemon")).toBeNull();
    });
  });

  describe("manifest structure", () => {
    test("ComponentEntry has required fields", () => {
      const entry = makeComponentEntry();

      expect(entry).toHaveProperty("version");
      expect(entry).toHaveProperty("installedAt");
      expect(entry).toHaveProperty("binaryPath");
      expect(entry).toHaveProperty("unitName");
    });

    test("installedAt is a valid ISO date", () => {
      const entry = makeComponentEntry();
      const date = new Date(entry.installedAt);
      expect(date.toISOString()).toBe(entry.installedAt);
    });
  });
});
