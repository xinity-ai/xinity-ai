import { describe, test, expect } from "bun:test";
import type { Page } from "playwright-core";
import { freshPage, ownerPage, type TestPage } from "../utils/browser";
import { expectVisible, waitFor } from "../utils/helpers";

function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) {
      violations.push(message.text());
    }
  });
  return violations;
}

async function expectNoViolations(open: () => Promise<TestPage>, path: string, ready?: (page: Page) => Promise<void>) {
  const { page, context } = await open();
  try {
    const violations = collectCspViolations(page);
    const response = await page.goto(path);
    expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
    await page.waitForLoadState("networkidle");
    expect(violations).toEqual([]);
    await ready?.(page);
    expect(violations).toEqual([]);
  } finally {
    await context.close();
  }
}

describe("Content Security Policy", () => {
  test("the app shell loads without violations", async () => {
    await expectNoViolations(ownerPage, "/");
  });

  test("the docs code examples load their theme without violations", async () => {
    await expectNoViolations(ownerPage, "/docs/api-reference", async (page) => {
      await expectVisible(page.locator("pre code").first());
    });
  });

  test("the API reference renders the spec without violations", async () => {
    await expectNoViolations(freshPage, "/api", async (page) => {
      await expectVisible(page.getByText("Xinity Orchestrator API").first());
    });
  });

  test("the login page loads without violations", async () => {
    await expectNoViolations(freshPage, "/login");
  });

  test("an injected inline script is refused and reported", async () => {
    const { page, context } = await freshPage();
    try {
      const violations = collectCspViolations(page);
      await page.goto("/login");
      await page.waitForLoadState("networkidle");

      const ran = await page.evaluate(() => {
        const script = document.createElement("script");
        script.textContent = "document.documentElement.dataset.injected = 'ran'";
        document.head.append(script);
        return document.documentElement.dataset.injected === "ran";
      });

      expect(ran).toBe(false);
      await waitFor(async () => expect(violations.some((v) => v.includes("script-src"))).toBe(true));
    } finally {
      await context.close();
    }
  });

  test("another file on the CDN is refused, since only the pinned bundle is allowed", async () => {
    const { page, context } = await freshPage();
    try {
      const violations = collectCspViolations(page);
      await page.goto("/login");
      await page.waitForLoadState("networkidle");

      const outcome = await page.evaluate(() => new Promise<string>((resolve) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/prismjs@1.30.0/prism.min.js";
        script.onload = () => resolve("loaded");
        script.onerror = () => resolve("blocked");
        document.head.append(script);
      }));

      expect(outcome).toBe("blocked");
      await waitFor(async () => expect(violations.some((v) => v.includes("cdn.jsdelivr.net/npm/prismjs"))).toBe(true));
    } finally {
      await context.close();
    }
  });
});
