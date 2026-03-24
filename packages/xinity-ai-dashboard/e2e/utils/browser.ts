import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { findBrowser } from "./browser-detection";
import { BASE_URL, STORAGE_STATE } from "./test-data";
import { ensureE2EReady } from "../guard";

let _browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    await ensureE2EReady();
    _browser = await chromium.launch({
      executablePath: findBrowser(),
      headless: !process.env.HEADED,
      args: process.env.CI
        ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        : [],
    });
  }
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    const b = _browser;
    _browser = null;
    await b.close();
  }
}

// Close browser when process exits (shared across all test files)
process.on("beforeExit", () => {
  _browser?.close();
});

export type TestPage = { context: BrowserContext; page: Page };

async function newPage(storageState?: string): Promise<TestPage> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    baseURL: BASE_URL,
    ...(storageState ? { storageState } : {}),
  });
  const page = await context.newPage();
  return { context, page };
}

export function ownerPage(): Promise<TestPage> {
  return newPage(STORAGE_STATE.owner);
}

export function viewerPage(): Promise<TestPage> {
  return newPage(STORAGE_STATE.viewer);
}

export function freshPage(): Promise<TestPage> {
  return newPage();
}
