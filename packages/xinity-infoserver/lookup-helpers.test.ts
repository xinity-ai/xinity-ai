import { describe, expect, it } from "bun:test";
import { deploymentLookup, deploymentEarlyLookup, installationLookup, installationKey, lookupKey } from "./lookup-helpers";

describe("deploymentLookup", () => {
  it("prefers canonical specifier when set", () => {
    expect(deploymentLookup({ specifier: "x", modelSpecifier: "y" })).toEqual({ kind: "canonical", specifier: "x" });
  });
  it("falls back to modelSpecifier when canonical specifier is null", () => {
    expect(deploymentLookup({ specifier: null, modelSpecifier: "y" })).toEqual({ kind: "legacy", providerModel: "y" });
  });
  it("returns null when neither identifier is provided", () => {
    expect(deploymentLookup({})).toBeNull();
  });
});

describe("deploymentEarlyLookup", () => {
  it("returns null when no canary model is configured", () => {
    expect(deploymentEarlyLookup({})).toBeNull();
  });
  it("prefers canonical earlySpecifier over legacy earlyModelSpecifier", () => {
    expect(deploymentEarlyLookup({ earlySpecifier: "a", earlyModelSpecifier: "b" })).toEqual({ kind: "canonical", specifier: "a" });
  });
});

describe("installationLookup / installationKey", () => {
  it("uses canonical key when specifier is set", () => {
    expect(installationKey({ specifier: "x", model: "legacy-y" })).toBe("x");
  });
  it("falls back to provider model for legacy installations", () => {
    expect(installationKey({ specifier: null, model: "legacy-y" })).toBe("legacy-y");
  });
});

describe("lookupKey", () => {
  it("returns the canonical specifier for canonical lookups", () => {
    expect(lookupKey({ kind: "canonical", specifier: "x" })).toBe("x");
  });
  it("returns the provider model for legacy lookups", () => {
    expect(lookupKey({ kind: "legacy", providerModel: "y" })).toBe("y");
  });
});
