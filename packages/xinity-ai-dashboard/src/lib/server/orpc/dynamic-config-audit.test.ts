import { describe, expect, test } from "bun:test";
import { auditableValue } from "../../../routes/(authenticated)/instance-settings/configuration/dynamic-config";

describe("auditableValue", () => {
  test("withholds a secret, so setting one never writes it into the audit log", () => {
    expect(auditableValue("LICENSE_KEY", "eyJ.signed")).toBeUndefined();
    expect(auditableValue("WEB_SEARCH_CREDENTIAL", "sk-live-abc")).toBeUndefined();
  });

  test("records what a non-secret was set to", () => {
    expect(auditableValue("RESPONSE_CACHE_TTL_SECONDS", "60")).toBe("60");
    expect(auditableValue("WEB_SEARCH_PROVIDER", "brave")).toBe("brave");
  });
});
