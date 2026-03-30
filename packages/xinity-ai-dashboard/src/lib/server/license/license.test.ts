import { describe, test, expect, beforeEach, mock } from "bun:test";
import crypto from "node:crypto";

// Generate a dedicated test key pair independent of the production key.
const testKeyPair = crypto.generateKeyPairSync("ed25519");
const testPublicKeyBase64 = testKeyPair.publicKey
  .export({ type: "spki", format: "der" })
  .toString("base64");

// Mock the public key module so parseLicense verifies against our test key.
mock.module("./public-key", () => ({
  PUBLIC_KEY_BASE64: testPublicKeyBase64,
}));

// Mock server env so we don't need the full SvelteKit env stack.
mock.module("$lib/server/serverenv", () => ({
  serverEnv: { ORIGIN: "https://dashboard.example.com", LICENSE_KEY: undefined },
  isInstanceAdmin: () => false,
}));

// Mock logger to suppress output during tests.
mock.module("$lib/server/logging", () => ({
  rootLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

// Now import the module under test (after mocks are in place).
const { parseLicense, resetLicenseCache, hasFeature, maxNodes, tierName, licenseeName, isExpired, isInGracePeriod, hasOriginMismatch, getLicenseSummary } = await import("./license");

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Signs a license payload with the test private key and returns a license key string. */
function signLicense(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const payloadBytes = Buffer.from(json, "utf-8");
  const signature = crypto.sign(null, payloadBytes, testKeyPair.privateKey);
  return `${payloadBytes.toString("base64url")}.${signature.toString("base64url")}`;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    tier: "enterprise-sm",
    maxNodes: 5,
    features: ["sso", "multi-org", "sso-self-manage", "all-roles"],
    licensee: "Test Corp",
    origins: ["https://dashboard.example.com"],
    issuedAt: Date.now(),
    expiresAt: Date.now() + 365 * MS_PER_DAY,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseLicense
// ---------------------------------------------------------------------------

describe("parseLicense", () => {
  test("accepts a valid, correctly signed license key", () => {
    const key = signLicense(validPayload());
    const result = parseLicense(key);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.payload.licensee).toBe("Test Corp");
    expect(result.payload.tier).toBe("enterprise-sm");
    expect(result.expired).toBe(false);
    expect(result.inGracePeriod).toBe(false);
  });

  test("rejects a key with an invalid signature", () => {
    const key = signLicense(validPayload());
    // Corrupt the signature by flipping a character
    const corrupted = key.slice(0, -2) + "XX";
    const result = parseLicense(corrupted);
    expect(result.valid).toBe(false);
  });

  test("rejects a key with no dot separator", () => {
    const result = parseLicense("nodothere");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("format");
  });

  test("rejects a key signed with a different private key", () => {
    const otherKey = crypto.generateKeyPairSync("ed25519");
    const payload = Buffer.from(JSON.stringify(validPayload()), "utf-8");
    const sig = crypto.sign(null, payload, otherKey.privateKey);
    const key = `${payload.toString("base64url")}.${sig.toString("base64url")}`;
    const result = parseLicense(key);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("signature");
  });

  test("rejects a payload missing required fields", () => {
    const incomplete = { version: 1, tier: "startup" }; // missing many fields
    const key = signLicense(incomplete);
    const result = parseLicense(key);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("Invalid license payload");
  });

  test("detects an expired key beyond grace period", () => {
    const key = signLicense(validPayload({
      expiresAt: Date.now() - 60 * MS_PER_DAY, // expired 60 days ago
    }));
    const result = parseLicense(key);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.expired).toBe(true);
    expect(result.inGracePeriod).toBe(false);
  });

  test("detects an expired key within grace period", () => {
    const key = signLicense(validPayload({
      expiresAt: Date.now() - 10 * MS_PER_DAY, // expired 10 days ago
    }));
    const result = parseLicense(key);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.expired).toBe(true);
    expect(result.inGracePeriod).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard functions (use getLicense / env-based cache)
// ---------------------------------------------------------------------------

describe("guard functions", () => {
  beforeEach(() => {
    resetLicenseCache();
    // Reset the mocked serverEnv LICENSE_KEY before each test
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = undefined;
    serverEnv.ORIGIN = "https://dashboard.example.com";
  });

  test("free tier: no key yields tier=free, maxNodes=1, no features", () => {
    expect(tierName()).toBe("free");
    expect(maxNodes()).toBe(1);
    expect(licenseeName()).toBeNull();
    expect(hasFeature("sso")).toBe(false);
    expect(hasFeature("all-roles")).toBe(false);
  });

  test("valid key: returns correct tier, maxNodes, features, licensee", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({ maxNodes: 5 }));

    expect(tierName()).toBe("enterprise-sm");
    expect(maxNodes()).toBe(5);
    expect(licenseeName()).toBe("Test Corp");
    expect(hasFeature("sso")).toBe(true);
    expect(hasFeature("multi-org")).toBe(true);
    expect(hasFeature("all-roles")).toBe(true);
    expect(isExpired()).toBe(false);
    expect(isInGracePeriod()).toBe(false);
  });

  test("startup key without enterprise features", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({
      tier: "startup",
      maxNodes: 2,
      features: ["all-roles"],
    }));

    expect(tierName()).toBe("startup");
    expect(maxNodes()).toBe(2);
    expect(hasFeature("all-roles")).toBe(true);
    expect(hasFeature("sso")).toBe(false);
    expect(hasFeature("multi-org")).toBe(false);
  });

  test("expired beyond grace period falls back to free tier", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({
      expiresAt: Date.now() - 60 * MS_PER_DAY,
    }));

    expect(tierName()).toBe("free");
    expect(maxNodes()).toBe(1);
    expect(hasFeature("sso")).toBe(false);
    expect(licenseeName()).toBeNull();
    expect(isExpired()).toBe(true);
    expect(isInGracePeriod()).toBe(false);
  });

  test("expired within grace period retains features", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({
      expiresAt: Date.now() - 10 * MS_PER_DAY,
    }));

    expect(tierName()).toBe("enterprise-sm");
    expect(hasFeature("sso")).toBe(true);
    expect(maxNodes()).toBe(5);
    expect(isExpired()).toBe(true);
    expect(isInGracePeriod()).toBe(true);
  });

  test("maxNodes -1 returns Infinity", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({ maxNodes: -1 }));

    expect(maxNodes()).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// Origin mismatch
// ---------------------------------------------------------------------------

describe("origin mismatch", () => {
  beforeEach(() => {
    resetLicenseCache();
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = undefined;
    serverEnv.ORIGIN = "https://dashboard.example.com";
  });

  test("no mismatch when origin matches", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({
      origins: ["https://dashboard.example.com"],
    }));

    expect(hasOriginMismatch()).toBe(false);
  });

  test("no mismatch when origin matches with trailing slash", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.ORIGIN = "https://dashboard.example.com/";
    serverEnv.LICENSE_KEY = signLicense(validPayload({
      origins: ["https://dashboard.example.com"],
    }));

    expect(hasOriginMismatch()).toBe(false);
  });

  test("no mismatch when any of multiple origins match", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({
      origins: ["https://other.example.com", "https://dashboard.example.com"],
    }));

    expect(hasOriginMismatch()).toBe(false);
  });

  test("mismatch when origin does not match any listed", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({
      origins: ["https://other.example.com"],
    }));

    expect(hasOriginMismatch()).toBe(true);
  });

  test("no mismatch on free tier (no key)", () => {
    expect(hasOriginMismatch()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getLicenseSummary
// ---------------------------------------------------------------------------

describe("getLicenseSummary", () => {
  beforeEach(() => {
    resetLicenseCache();
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = undefined;
    serverEnv.ORIGIN = "https://dashboard.example.com";
  });

  test("returns complete summary for free tier", () => {
    const summary = getLicenseSummary();
    expect(summary.tier).toBe("free");
    expect(summary.licensee).toBeNull();
    expect(summary.expired).toBe(false);
    expect(summary.inGracePeriod).toBe(false);
    expect(summary.originMismatch).toBe(false);
    expect(summary.maxNodes).toBe(1);
    expect(summary.features.sso).toBe(false);
    expect(summary.features.multiOrg).toBe(false);
    expect(summary.features.allRoles).toBe(false);
  });

  test("returns complete summary for paid tier", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload());

    const summary = getLicenseSummary();
    expect(summary.tier).toBe("enterprise-sm");
    expect(summary.licensee).toBe("Test Corp");
    expect(summary.maxNodes).toBe(5);
    expect(summary.features.sso).toBe(true);
    expect(summary.features.multiOrg).toBe(true);
    expect(summary.features.allRoles).toBe(true);
    expect(summary.originMismatch).toBe(false);
  });
});
