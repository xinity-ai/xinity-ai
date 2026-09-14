import { randomBytes } from "node:crypto";

export function randomToken(length = 40): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

/** Not in getAutoDefaults: that also feeds stack deploys, where per-call secrets would differ per host. */
export function initialSharedSecrets(): Record<string, string> {
  return {
    BETTER_AUTH_SECRET: randomToken(),
    TETHER_SECRET: randomToken(),
  };
}
