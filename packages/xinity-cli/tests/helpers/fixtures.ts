/**
 * Shared test fixtures for CLI tests.
 */
import type { Release, ReleaseAsset } from "../../src/lib/github.ts";
import type { Manifest, ComponentEntry } from "../../src/lib/manifest.ts";
import type { CliConfig } from "../../src/lib/config.ts";

export function makeAsset(overrides: Partial<ReleaseAsset> = {}): ReleaseAsset {
  return {
    name: "xinity-ai-gateway-linux-x64.zip",
    apiUrl: "https://api.github.com/repos/test/repo/releases/assets/123",
    browserDownloadUrl: "https://github.com/test/repo/releases/download/v1.0.0/gateway.zip",
    size: 1024 * 1024,
    ...overrides,
  };
}

export function makeRelease(overrides: Partial<Release> = {}): Release {
  return {
    tagName: "v1.0.0",
    name: "Release v1.0.0",
    assets: [
      makeAsset({ name: "xinity-ai-gateway-linux-x64.zip" }),
      makeAsset({ name: "xinity-ai-dashboard.tar.gz" }),
      makeAsset({ name: "xinity-ai-daemon-linux-x64.zip" }),
      makeAsset({ name: "xinity-cli-linux-x64.zip" }),
      makeAsset({ name: "db-migrations.tar.gz" }),
      makeAsset({ name: "SHASUMS256.txt" }),
    ],
    ...overrides,
  };
}

export function makeComponentEntry(overrides: Partial<ComponentEntry> = {}): ComponentEntry {
  return {
    version: "v1.0.0",
    installedAt: new Date().toISOString(),
    binaryPath: "/opt/xinity/bin/xinity-ai-gateway",
    unitName: "xinity-ai-gateway.service",
    ...overrides,
  };
}

export function makeManifest(components: Partial<Record<string, ComponentEntry>> = {}): Manifest {
  return { components };
}

export function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    apiKey: "test-api-key-123",
    dashboardUrl: "http://localhost:5173",
    githubProjectUrl: "https://github.com/test/repo",
    ...overrides,
  };
}

/** SHA256 checksum file content for testing. */
export const SAMPLE_CHECKSUMS = [
  "abc123def456abc123def456abc123def456abc123def456abc123def456abc12345  xinity-ai-gateway-linux-x64.zip",
  "def456abc123def456abc123def456abc123def456abc123def456abc123def45678  xinity-ai-dashboard.tar.gz",
  "789abcdef012789abcdef012789abcdef012789abcdef012789abcdef012789abc  xinity-cli-linux-x64.zip",
].join("\n");
