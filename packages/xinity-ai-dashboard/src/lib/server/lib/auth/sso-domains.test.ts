import { describe, test, expect } from "bun:test";
import { isEmailInProviderDomain, providerEmailDomains } from "./sso-domains";

describe("isEmailInProviderDomain", () => {
  test("accepts the provider's domain and its subdomains", () => {
    expect(isEmailInProviderDomain("alice@corp.com", "corp.com")).toBe(true);
    expect(isEmailInProviderDomain("alice@eu.corp.com", "corp.com")).toBe(true);
  });

  test("rejects a domain that merely ends with the provider's domain", () => {
    expect(isEmailInProviderDomain("mallory@evilcorp.com", "corp.com")).toBe(false);
  });

  test("rejects an address outside every listed domain", () => {
    expect(isEmailInProviderDomain("admin@victim.com", "corp.com, corp.de")).toBe(false);
  });

  test("matches any domain in a comma-separated list, ignoring case", () => {
    expect(isEmailInProviderDomain("Bob@CORP.DE", "corp.com, corp.de")).toBe(true);
  });

  test("rejects an address without a domain", () => {
    expect(isEmailInProviderDomain("alice", "corp.com")).toBe(false);
    expect(isEmailInProviderDomain("alice@", "corp.com")).toBe(false);
  });

  test("rejects everything when the provider has no domain", () => {
    expect(isEmailInProviderDomain("alice@corp.com", "")).toBe(false);
  });
});

describe("providerEmailDomains", () => {
  test("reduces URL-shaped entries to their hostname", () => {
    expect(providerEmailDomains("https://Corp.com/login, corp.de")).toEqual(["corp.com", "corp.de"]);
  });
});
