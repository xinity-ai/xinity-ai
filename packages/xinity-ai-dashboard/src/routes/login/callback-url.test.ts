import { describe, test, expect } from "bun:test";
import { safeCallbackPath } from "./callback-url";

describe("safeCallbackPath", () => {
  test("keeps a same-site path with its query and hash", () => {
    expect(safeCallbackPath("/organizations/accept-invitation-abc?x=1#top")).toBe("/organizations/accept-invitation-abc?x=1#top");
  });

  test.each([
    ["missing", null],
    ["absolute", "https://evil.com/"],
    ["scheme-relative", "//evil.com"],
    ["backslash", "/\\evil.com"],
    ["tab", "/\t/evil.com"],
    ["newline", "/\n/evil.com"],
    ["relative", "evil.com"],
  ])("falls back to / for a %s target", (_, raw) => {
    expect(safeCallbackPath(raw)).toBe("/");
  });
});
