import type { Locator, Page } from "playwright-core";

/** Poll until fn() stops throwing, or throw after timeout. */
export async function waitFor(fn: () => Promise<void>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fn();
      return;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastError;
}

export async function expectVisible(locator: Locator, timeout = 30_000) {
  await locator.waitFor({ state: "visible", timeout });
}

export async function expectHidden(locator: Locator, timeout = 15_000) {
  await locator.waitFor({ state: "hidden", timeout });
}

export async function expectValue(
  locator: Locator,
  value: string,
  timeout = 30_000,
) {
  await waitFor(async () => {
    const actual = await locator.inputValue();
    if (actual !== value)
      throw new Error(`Expected value "${value}", got "${actual}"`);
  }, timeout);
}

export async function expectURL(
  page: Page,
  pattern: string | RegExp,
  timeout = 30_000,
) {
  await page.waitForURL(pattern, { timeout });
}
