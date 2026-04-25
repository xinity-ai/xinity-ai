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

// Mock the deployment-id module so we can control the local instance ID.
const deploymentIdMock = { id: null as string | null };
mock.module("$lib/server/deployment-id", () => ({
  getDeploymentId: () => deploymentIdMock.id,
}));

// Now import the module under test (after mocks are in place).
const { parseLicense, resetLicenseCache, hasFeature, maxVramGb, tierName, licenseeName, isExpired, isInGracePeriod, hasOriginMismatch, hasInstanceMismatch, getLicenseSummary } = await import("./license");

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
    maxVramGb: 500,
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

  test("free tier: no key yields tier=free, maxVramGb=120, no features", () => {
    expect(tierName()).toBe("free");
    expect(maxVramGb()).toBe(120);
    expect(licenseeName()).toBeNull();
    expect(hasFeature("sso")).toBe(false);
    expect(hasFeature("all-roles")).toBe(false);
  });

  test("valid key: returns correct tier, maxVramGb, features, licensee", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({ maxVramGb: 500 }));

    expect(tierName()).toBe("enterprise-sm");
    expect(maxVramGb()).toBe(500);
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
      maxVramGb: 200,
      features: ["all-roles"],
    }));

    expect(tierName()).toBe("startup");
    expect(maxVramGb()).toBe(200);
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
    expect(maxVramGb()).toBe(120);
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
    expect(maxVramGb()).toBe(500);
    expect(isExpired()).toBe(true);
    expect(isInGracePeriod()).toBe(true);
  });

  test("maxVramGb -1 returns Infinity", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({ maxVramGb: -1 }));

    expect(maxVramGb()).toBe(Infinity);
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
// Instance mismatch
// ---------------------------------------------------------------------------

describe("instance mismatch", () => {
  beforeEach(() => {
    resetLicenseCache();
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = undefined;
    serverEnv.ORIGIN = "https://dashboard.example.com";
    deploymentIdMock.id = null;
  });

  // Valid UUIDs (v4 with proper variant bits) for test fixtures.
  const ID_A = "11111111-1111-4111-8111-111111111111";
  const ID_B = "22222222-2222-4222-8222-222222222222";

  test("no mismatch when license has no instanceId claim (backwards compatible)", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload());
    deploymentIdMock.id = ID_A;

    expect(hasInstanceMismatch()).toBe(false);
  });

  test("no mismatch when license instanceId equals local deployment ID", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({ instanceId: ID_A }));
    deploymentIdMock.id = ID_A;

    expect(hasInstanceMismatch()).toBe(false);
  });

  test("mismatch when license instanceId differs from local deployment ID", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({ instanceId: ID_A }));
    deploymentIdMock.id = ID_B;

    expect(hasInstanceMismatch()).toBe(true);
  });

  test("no mismatch when local deployment ID has not loaded yet", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({ instanceId: ID_A }));
    deploymentIdMock.id = null;

    expect(hasInstanceMismatch()).toBe(false);
  });

  test("no mismatch on free tier (no key)", () => {
    deploymentIdMock.id = ID_A;
    expect(hasInstanceMismatch()).toBe(false);
  });

  test("rejects a non-UUID instanceId at parse time", () => {
    const key = signLicense(validPayload({ instanceId: "not-a-uuid" }));
    const result = parseLicense(key);
    expect(result.valid).toBe(false);
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
    deploymentIdMock.id = null;
  });

  test("returns complete summary for free tier", () => {
    const summary = getLicenseSummary();
    expect(summary.tier).toBe("free");
    expect(summary.licensee).toBeNull();
    expect(summary.expired).toBe(false);
    expect(summary.inGracePeriod).toBe(false);
    expect(summary.originMismatch).toBe(false);
    expect(summary.instanceMismatch).toBe(false);
    expect(summary.maxVramGb).toBe(120);
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
    expect(summary.maxVramGb).toBe(500);
    expect(summary.features.sso).toBe(true);
    expect(summary.features.multiOrg).toBe(true);
    expect(summary.features.allRoles).toBe(true);
    expect(summary.originMismatch).toBe(false);
    expect(summary.instanceMismatch).toBe(false);
  });

  test("surfaces instanceMismatch when license instanceId differs from local", () => {
    const { serverEnv } = require("$lib/server/serverenv");
    serverEnv.LICENSE_KEY = signLicense(validPayload({
      instanceId: "33333333-3333-4333-8333-333333333333",
    }));
    deploymentIdMock.id = "44444444-4444-4444-8444-444444444444";

    const summary = getLicenseSummary();
    expect(summary.instanceMismatch).toBe(true);
  });
});
