import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { PinoLike } from "./pino-like";

/** The whole `enc.` namespace is reserved, so a later format is refused rather than read as plaintext. */
export const SEALED_PREFIX = "enc.";
const VERSION = `${SEALED_PREFIX}v1`;
const SEPARATOR = ":";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const DIGEST_CHARS = 16;

type Key = { id: string; enc: Buffer; mac: Buffer };

function subkey(bytes: Buffer, purpose: string, length = KEY_BYTES): Buffer {
  return Buffer.from(hkdfSync("sha256", bytes, "", `xinity-${purpose}-v1`, length));
}

function parseKey(raw: string, envKey: string): Key {
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== KEY_BYTES) {
    throw new Error(
      `${envKey} must be ${KEY_BYTES} bytes of base64 (openssl rand -base64 32), got ${bytes.length}`,
    );
  }
  return {
    id: subkey(bytes, "key-id", 6).toString("base64url"),
    enc: subkey(bytes, "encryption"),
    mac: subkey(bytes, "digest"),
  };
}

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

export type SecretKeyring = {
  seal: (plaintext: string) => string;
  /** Anything not sealed passes through, so a deployment can adopt encryption without a flag day. */
  open: (value: string) => string;
  digest: (plaintext: string) => string;
};

export function createSecretKeyring(keys: { current: string; previous?: string }): SecretKeyring {
  const current = parseKey(keys.current, "XINITY_SECRET_KEY");
  const accepted = [current];
  if (keys.previous !== undefined) {
    accepted.push(parseKey(keys.previous, "XINITY_SECRET_KEY_PREVIOUS"));
  }

  return {
    seal(plaintext) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", current.enc, nonce);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [
        VERSION,
        current.id,
        nonce.toString("base64url"),
        body.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join(SEPARATOR);
    },

    open(value) {
      if (!isSealed(value)) {
        return value;
      }

      if (!value.startsWith(`${VERSION}${SEPARATOR}`)) {
        throw new Error(
          `Sealed as ${value.split(SEPARATOR)[0]}, which this build cannot open: it understands ${VERSION}`,
        );
      }

      const [, id, nonce, body, tag, ...rest] = value.split(SEPARATOR);
      if (id === undefined || nonce === undefined || body === undefined || tag === undefined || rest.length > 0) {
        throw new Error(`Malformed ${VERSION} envelope`);
      }

      const key = accepted.find((candidate) => candidate.id === id);
      if (!key) {
        throw new Error(
          `No configured key can open this value: it was sealed with key ${id}, `
          + `and XINITY_SECRET_KEY${keys.previous === undefined ? "" : "/_PREVIOUS"} `
          + `${accepted.length === 1 ? "is" : "are"} ${accepted.map((k) => k.id).join(", ")}`,
        );
      }

      const decipher = createDecipheriv("aes-256-gcm", key.enc, Buffer.from(nonce, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return decipher.update(Buffer.from(body, "base64url")).toString("utf8") + decipher.final("utf8");
    },

    digest(plaintext) {
      return createHmac("sha256", current.mac).update(plaintext).digest("base64url").slice(0, DIGEST_CHARS);
    },
  };
}

export type SecretKeys = { current?: string; previous?: string };

export function createSecretUnsealer(keys: SecretKeys, log: PinoLike) {
  const keyring = keys.current === undefined
    ? null
    : createSecretKeyring({ current: keys.current, previous: keys.previous });

  return (envKey: string, value: string): string | undefined => {
    if (!isSealed(value)) {
      return value;
    }

    if (keyring === null) {
      log.error(
        { envKey },
        "Ignoring an encrypted setting: XINITY_SECRET_KEY is not set on this host, so it cannot be read",
      );
      return undefined;
    }

    try {
      return keyring.open(value);
    } catch (err) {
      log.error({ err, envKey }, "Ignoring an encrypted setting that could not be decrypted");
      return undefined;
    }
  };
}
