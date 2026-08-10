import { z } from "zod";

export const LICENSE_USES = ["open", "conditional", "non-commercial", "unknown"] as const;
export type LicenseUse = (typeof LICENSE_USES)[number];

const LICENSE_USE_DESCRIPTION =
  "How far the license restricts using this model. " +
  "`open` places no meaningful limit on use (Apache-2.0, MIT, CC-BY). " +
  "`conditional` allows commercial use within bounds: revenue or user thresholds, acceptable-use policies, naming requirements. " +
  "`non-commercial` forbids commercial use. " +
  "`unknown` means the publisher states no terms, or terms this version does not recognise. " +
  "This describes freedom to use, not obligations on redistribution, so copyleft licenses are `open`.";

/**
 * Unrecognised values degrade to "unknown" instead of failing the parse, which is what
 * lets a value be added later without older clients dropping the entry. The fallback
 * must stay at the cautious end, never "open".
 */
export const LicenseUseEnum = z.enum(LICENSE_USES).catch("unknown").describe(LICENSE_USE_DESCRIPTION);

type KnownLicense =
  | { name: string; url: string; use: "open" }
  | { name: string; url: string; use: Exclude<LicenseUse, "open">; summary: string };

const KNOWN_LICENSES = {
  "apache-2.0": {
    name: "Apache-2.0",
    url: "https://www.apache.org/licenses/LICENSE-2.0",
    use: "open",
  },
  "mit": {
    name: "MIT",
    url: "https://opensource.org/license/mit",
    use: "open",
  },
  "bsd-3-clause": {
    name: "BSD-3-Clause",
    url: "https://opensource.org/license/bsd-3-clause",
    use: "open",
  },
  "mpl-2.0": {
    name: "MPL-2.0",
    url: "https://www.mozilla.org/en-US/MPL/2.0/",
    use: "open",
  },
  "gpl-3.0": {
    name: "GPL-3.0",
    url: "https://www.gnu.org/licenses/gpl-3.0.html",
    use: "open",
  },
  "agpl-3.0": {
    name: "AGPL-3.0",
    url: "https://www.gnu.org/licenses/agpl-3.0.html",
    use: "open",
  },
  "cc-by-4.0": {
    name: "CC-BY-4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    use: "open",
  },
  "cc-by-sa-4.0": {
    name: "CC-BY-SA-4.0",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    use: "open",
  },
  "cc-by-nc-4.0": {
    name: "CC-BY-NC-4.0",
    url: "https://creativecommons.org/licenses/by-nc/4.0/",
    use: "non-commercial",
    summary: "Non-commercial use only. Any commercial deployment needs separate permission from the rights holder.",
  },
} as const satisfies Record<string, KnownLicense>;

type KnownLicenseId = keyof typeof KNOWN_LICENSES;

const KNOWN_LICENSE_IDS = Object.keys(KNOWN_LICENSES) as [KnownLicenseId, ...KnownLicenseId[]];

export const LicenseObjectSchema = z.looseObject({
  id: z.string().optional().describe("SPDX identifier, when this is a standard license. Display only"),
  name: z.string().describe("Display name of the license"),
  url: z.url().describe("Link to the license text. For an unstated license, link the page a user should check instead"),
  use: LicenseUseEnum,
  summary: z.string().optional().describe("One or two sentences telling a user what they may and may not do with this model. Required unless the license is open"),
}).refine(
  license => license.use === "open" || Boolean(license.summary),
  { message: "summary is required unless the license is open", path: ["summary"] },
);

export type ModelLicense = {
  id?: string;
  name: string;
  url: string;
  use: LicenseUse;
  summary?: string;
};

/**
 * The shorthand resolves at parse time, so a published catalog only ever carries the
 * object form and a client never has to know the identifiers.
 */
export const LicenseSchema = z.union([
  z.enum(KNOWN_LICENSE_IDS)
    .describe("Identifier of a well-known license, expanded by the server into the full object")
    .transform((id): ModelLicense => ({ id, ...KNOWN_LICENSES[id] })),
  LicenseObjectSchema,
]);
