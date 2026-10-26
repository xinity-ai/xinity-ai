import { describe, test, expect } from "bun:test";
import { version } from "../../../package.json";
import { deprecations, isRemovedBy, reportDeprecations, type Deprecation } from "./deprecations";

describe("deprecation registry", () => {
  const entries = Object.entries(deprecations as Record<string, Deprecation>);

  test("nothing outlives the release that announced its removal", () => {
    const overdue = entries
      .filter(([, entry]) => isRemovedBy(entry.removedIn, version))
      .map(([id, entry]) => `${id} (removedIn ${entry.removedIn})`);

    expect(overdue).toEqual([]);
  });

  test("every entry names a valid version and announcement date", () => {
    for (const [id, entry] of entries) {
      expect(Bun.semver.order(entry.removedIn, "0.0.0"), id).toBe(1);
      expect(Number.isNaN(Date.parse(entry.deprecatedSince)), id).toBe(false);
    }
  });
});

describe("isRemovedBy", () => {
  test("the removal release and everything after it no longer carry the deprecation", () => {
    expect(isRemovedBy("0.30.0", "0.29.4")).toBe(false);
    expect(isRemovedBy("0.30.0", "0.30.0")).toBe(true);
    expect(isRemovedBy("0.30.0", "v0.31.2")).toBe(true);
  });
});

describe("reportDeprecations", () => {
  test("reports only what is still depended on, with its removal version", async () => {
    const reports = await reportDeprecations({
      "gateway.web-search-engine-url": async () => "WEB_SEARCH_ENGINE_URL is set.",
      "infoserver.legacy-model-dir": async () => null,
    });

    expect(reports).toEqual([{
      id: "gateway.web-search-engine-url",
      removedIn: deprecations["gateway.web-search-engine-url"].removedIn,
      message: "WEB_SEARCH_ENGINE_URL is set.",
    }]);
  });

  test("a check that fails reads as still depended on, never as clean", async () => {
    const [report] = await reportDeprecations({
      "dashboard.legacy-api-calls": async () => {
        throw new Error("connection refused");
      },
    });

    expect(report?.message).toBe("Could not be checked: connection refused");
  });
});
