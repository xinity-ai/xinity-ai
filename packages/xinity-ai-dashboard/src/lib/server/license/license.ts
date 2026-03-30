import crypto from "node:crypto";
import { LicensePayloadSchema, type LicenseInfo, type LicenseFeature } from "./types";
import { PUBLIC_KEY_BASE64 } from "./public-key";
import { rootLogger } from "$lib/server/logging";
import { serverEnv } from "../serverenv";

const log = rootLogger.child({ name: "license" });

const GRACE_PERIOD_DAYS = 30;
const FREE_MAX_VRAM_GB = 120;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

let cachedLicense: LicenseInfo | null = null;

/**
 * Parses and cryptographically verifies a license key string.
 * Format: base64url(JSON payload).base64url(Ed25519 signature)
 */
export function parseLicense(key: string): LicenseInfo {
  try {
    const dotIndex = key.indexOf(".");
    if (dotIndex === -1) {
      return { valid: false, reason: "Invalid license key format" };
    }

    const payloadB64 = key.slice(0, dotIndex);
    const signatureB64 = key.slice(dotIndex + 1);

    const payloadBytes = Buffer.from(payloadB64, "base64url");
    const signatureBytes = Buffer.from(signatureB64, "base64url");

    // Verify Ed25519 signature
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(PUBLIC_KEY_BASE64, "base64"),
      format: "der",
      type: "spki",
    });

    const valid = crypto.verify(null, payloadBytes, publicKey, signatureBytes);
    if (!valid) {
      return { valid: false, reason: "Invalid license key signature" };
    }

    // Parse and validate payload
    const rawPayload = JSON.parse(payloadBytes.toString("utf-8"));
    const result = LicensePayloadSchema.safeParse(rawPayload);
    if (!result.success) {
      return { valid: false, reason: `Invalid license payload: ${result.error.message}` };
    }

    const payload = result.data;
    const now = Date.now();
    const expired = now > payload.expiresAt;
    const inGracePeriod = expired && now < payload.expiresAt + GRACE_PERIOD_DAYS * MS_PER_DAY;

    return { valid: true, payload, expired, inGracePeriod };
  } catch (err) {
    return { valid: false, reason: `Failed to parse license key: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Returns true if a paid license is active but its origin doesn't match the dashboard's ORIGIN.
 * Free tier (no key) is exempt. Origin only matters for paid licenses.
 */
export function hasOriginMismatch(): boolean {
  const license = getLicense();
  if (!license.valid) return false;
  const dashboardOrigin = serverEnv.ORIGIN.replace(/\/+$/, "");
  return !license.payload.origins.some(
    (o) => o.replace(/\/+$/, "") === dashboardOrigin,
  );
}

/**
 * Returns the current license info. Reads from LICENSE_KEY env var on first call, then caches.
 * Returns a free-tier fallback if no key is set or if the key is invalid.
 */
export function getLicense(): LicenseInfo {
  if (cachedLicense) return cachedLicense;

  const key = serverEnv.LICENSE_KEY;
  if (!key) {
    cachedLicense = { valid: false, reason: "No license key configured" };
    log.info("No LICENSE_KEY set. Running in free tier");
    return cachedLicense;
  }

  cachedLicense = parseLicense(key);
  if (cachedLicense.valid) {
    if (cachedLicense.expired && !cachedLicense.inGracePeriod) {
      log.warn({ licensee: cachedLicense.payload.licensee }, "License expired beyond grace period. Falling back to free tier");
    } else if (cachedLicense.inGracePeriod) {
      const daysLeft = Math.ceil((cachedLicense.payload.expiresAt + GRACE_PERIOD_DAYS * MS_PER_DAY - Date.now()) / MS_PER_DAY);
      log.warn({ licensee: cachedLicense.payload.licensee, daysLeft }, "License expired. Grace period active");
    } else {
      log.info({ tier: cachedLicense.payload.tier, licensee: cachedLicense.payload.licensee }, "License validated");
    }

    // Check origin mismatch
    if (hasOriginMismatch()) {
      log.error(
        { allowedOrigins: cachedLicense.payload.origins, actual: serverEnv.ORIGIN },
        "LICENSE ORIGIN MISMATCH: The dashboard ORIGIN does not match the licensed origin. The dashboard will idle until this is corrected.",
      );
    }
  } else {
    log.warn({ reason: cachedLicense.reason }, "Invalid license key. Running in free tier");
  }

  return cachedLicense;
}

/** Resets the cached license (useful for testing). */
export function resetLicenseCache(): void {
  cachedLicense = null;
}

/**
 * Returns true if the active license includes the given feature.
 * Expired licenses beyond grace period are treated as free tier (no features).
 */
export function hasFeature(feature: LicenseFeature): boolean {
  const license = getLicense();
  if (!license.valid) return false;
  if (license.expired && !license.inGracePeriod) return false;
  return license.payload.features.includes(feature);
}

/** Returns the maximum total VRAM (in GB) allowed by the current license. */
export function maxVramGb(): number {
  const license = getLicense();
  if (!license.valid) return FREE_MAX_VRAM_GB;
  if (license.expired && !license.inGracePeriod) return FREE_MAX_VRAM_GB;
  if (license.payload.maxVramGb === -1) return Infinity;
  return license.payload.maxVramGb;
}

/** Returns the current tier name. */
export function tierName(): "free" | "startup" | "enterprise-sm" | "enterprise-lg" {
  const license = getLicense();
  if (!license.valid) return "free";
  if (license.expired && !license.inGracePeriod) return "free";
  return license.payload.tier;
}

/** Returns the licensee name, or null if on free tier. */
export function licenseeName(): string | null {
  const license = getLicense();
  if (!license.valid) return null;
  if (license.expired && !license.inGracePeriod) return null;
  return license.payload.licensee;
}

/** Returns true if the license is expired (regardless of grace period). */
export function isExpired(): boolean {
  const license = getLicense();
  if (!license.valid) return false;
  return license.expired;
}

/** Returns true if the license is in the grace period (expired < 30 days). */
export function isInGracePeriod(): boolean {
  const license = getLicense();
  if (!license.valid) return false;
  return license.inGracePeriod;
}

/** Returns license summary data safe to expose to the client (layout data). */
export function getLicenseSummary() {
  return {
    tier: tierName(),
    licensee: licenseeName(),
    expired: isExpired(),
    inGracePeriod: isInGracePeriod(),
    originMismatch: hasOriginMismatch(),
    maxVramGb: maxVramGb(),
    features: {
      sso: hasFeature("sso"),
      multiOrg: hasFeature("multi-org"),
      ssoSelfManage: hasFeature("sso-self-manage"),
      allRoles: hasFeature("all-roles"),
    },
  };
}

export type LicenseSummary = ReturnType<typeof getLicenseSummary>;
