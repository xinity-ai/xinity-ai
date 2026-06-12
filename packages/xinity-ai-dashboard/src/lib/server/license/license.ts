import crypto from "node:crypto";
import { LicensePayloadSchema, type LicenseInfo, type LicenseFeature, type LicensePayload, type LicenseTier } from "./types";
import { PUBLIC_KEY_BASE64 } from "./public-key";
import { rootLogger } from "$lib/server/logging";
import { serverEnv } from "../serverenv";
import { getDeploymentId } from "../deployment-id";

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
 * Returns true if a paid license is active and carries an instanceId claim
 * that does not match this dashboard's deployment instance ID.
 *
 * Licenses without an instanceId claim are unbounded and always pass.
 * If the deployment ID has not yet loaded (cold start, DB unreachable),
 * we cannot verify - return false to avoid false positives, the warmup
 * pass in hooks.server.ts triggers a re-evaluation on the next call.
 */
export function hasInstanceMismatch(): boolean {
  const license = getLicense();
  if (!license.valid) return false;
  const claim = license.payload.instanceId;
  if (!claim) return false;
  const local = getDeploymentId();
  if (!local) return false;
  return claim !== local;
}

function logLicenseLifecycle(license: LicenseInfo): void {
  if (!license.valid) {
    log.warn({ reason: license.reason }, "Invalid license key. Running in free tier");
    return;
  }

  const { licensee, tier, expiresAt } = license.payload;
  if (license.expired && !license.inGracePeriod) {
    log.warn({ licensee }, "License expired beyond grace period. Falling back to free tier");
  } else if (license.inGracePeriod) {
    const daysLeft = Math.ceil((expiresAt + GRACE_PERIOD_DAYS * MS_PER_DAY - Date.now()) / MS_PER_DAY);
    log.warn({ licensee, daysLeft }, "License expired. Grace period active");
  } else {
    log.info({ tier, licensee }, "License validated");
  }

  if (hasOriginMismatch()) {
    log.error(
      { allowedOrigins: license.payload.origins, actual: serverEnv.ORIGIN },
      "LICENSE ORIGIN MISMATCH: The dashboard ORIGIN does not match the licensed origin. Treating as free tier until this is corrected.",
    );
  }

  if (hasInstanceMismatch()) {
    log.error(
      { licensedInstanceId: license.payload.instanceId, actual: getDeploymentId() },
      "LICENSE INSTANCE MISMATCH: The dashboard instance ID does not match the licensed instance ID. Treating as free tier until this is corrected.",
    );
  }
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
  logLicenseLifecycle(cachedLicense);
  return cachedLicense;
}

/** Resets the cached license (useful for testing). */
export function resetLicenseCache(): void {
  cachedLicense = null;
}

function effectiveLicensePayload(): LicensePayload | null {
  const license = getLicense();
  if (!license.valid) return null;
  if (license.expired && !license.inGracePeriod) return null;
  if (hasOriginMismatch()) return null;
  if (hasInstanceMismatch()) return null;
  return license.payload;
}

/**
 * Returns true when the parsed license is considered to be fully valid.
 */
export function isLicenseEffective(): boolean {
  return effectiveLicensePayload() !== null;
}

/**
 * Returns true if the active license includes the given feature.
 * Expired licenses beyond grace period are treated as free tier (no features).
 */
export function hasFeature(feature: LicenseFeature): boolean {
  return effectiveLicensePayload()?.features.includes(feature) ?? false;
}

/** Returns the maximum total VRAM (in GB) allowed by the current license. */
export function maxVramGb(): number {
  const payload = effectiveLicensePayload();
  if (!payload) return FREE_MAX_VRAM_GB;
  if (payload.maxVramGb === -1) return Infinity;
  return payload.maxVramGb;
}

/** Returns the current tier name. */
export function tierName(): LicenseTier | "free" {
  return effectiveLicensePayload()?.tier ?? "free";
}

/** Returns the licensee name, or null if on free tier. */
export function licenseeName(): string | null {
  return effectiveLicensePayload()?.licensee ?? null;
}

/** Returns true if the license is expired (regardless of grace period). */
export function isExpired(): boolean {
  const license = getLicense();
  return license.valid && license.expired;
}

/** Returns true if the license is in the grace period (expired < 30 days). */
export function isInGracePeriod(): boolean {
  const license = getLicense();
  return license.valid && license.inGracePeriod;
}

/** Returns license summary data safe to expose to the client (layout data). */
export function getLicenseSummary() {
  return {
    tier: tierName(),
    licensee: licenseeName(),
    expired: isExpired(),
    inGracePeriod: isInGracePeriod(),
    originMismatch: hasOriginMismatch(),
    instanceMismatch: hasInstanceMismatch(),
    maxVramGb: maxVramGb(),
    features: {
      sso: hasFeature("sso"),
      multiOrg: hasFeature("multi-org"),
      ssoSelfManage: hasFeature("sso-self-manage"),
      allRoles: hasFeature("all-roles"),
      auditLog: hasFeature("audit-log"),
      complianceReports: hasFeature("compliance-reports"),
    },
  };
}

export type LicenseSummary = ReturnType<typeof getLicenseSummary>;
