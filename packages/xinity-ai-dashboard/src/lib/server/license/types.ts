import { z } from "zod";

export const LicenseTier = z.enum(["startup", "enterprise-sm", "enterprise-lg"]);
export type LicenseTier = z.infer<typeof LicenseTier>;

export const LicenseFeature = z.enum(["sso", "multi-org", "sso-self-manage", "all-roles"]);
export type LicenseFeature = z.infer<typeof LicenseFeature>;

export const LicensePayloadSchema = z.object({
  version: z.literal(1),
  tier: LicenseTier,
  maxNodes: z.number().int(),
  features: z.array(LicenseFeature),
  licensee: z.string().min(1),
  origins: z.array(z.string().min(1)).min(1),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
});

export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

export type LicenseInfo = {
  valid: true;
  payload: LicensePayload;
  expired: boolean;
  inGracePeriod: boolean;
} | {
  valid: false;
  reason: string;
};

