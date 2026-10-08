import { describe, test, expect } from "bun:test";
import { generateApiKey } from "./api-key";

describe("generateApiKey", () => {
  test("issues a 25 character specifier that prefixes the full key", () => {
    const { specifier, fullKey } = generateApiKey();

    expect(specifier).toHaveLength(25);
    expect(specifier.startsWith("sk_")).toBe(true);
    expect(fullKey.startsWith(specifier)).toBe(true);
  });

  test("issues a secret with at least 256 bits of entropy", () => {
    const { specifier, fullKey } = generateApiKey();
    const secret = fullKey.slice(specifier.length);

    // base64url carries 6 bits per character
    expect(secret.length * 6).toBeGreaterThanOrEqual(256);
  });

  test("never repeats a key", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().fullKey));

    expect(keys.size).toBe(200);
  });
});
