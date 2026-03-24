import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CANDIDATES = [
  "brave",
  "brave-browser",
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "microsoft-edge",
];

const CANDIDATE_PATHS = [
  // NixOS / nix-profile
  ...CANDIDATES.map((c) => join(homedir(), ".nix-profile", "bin", c)),
  // Standard Linux
  ...CANDIDATES.map((c) => join("/usr/bin", c)),
  ...CANDIDATES.map((c) => join("/usr/local/bin", c)),
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function which(name: string): string | null {
  try {
    return execSync(`which ${name}`, { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

export function findBrowser(): string {
  // 1. Explicit env var override
  const envPath = process.env.BROWSER_PATH;
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    throw new Error(`BROWSER_PATH="${envPath}" does not exist`);
  }

  // 2. which lookup
  for (const name of CANDIDATES) {
    const found = which(name);
    if (found) return found;
  }

  // 3. Candidate paths
  for (const p of CANDIDATE_PATHS) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    [
      "No Chromium-based browser found.",
      "Install Chrome/Chromium/Brave/Edge, or set the BROWSER_PATH env var.",
      `Searched: ${CANDIDATES.join(", ")} via which, plus ${CANDIDATE_PATHS.length} known paths.`,
    ].join("\n"),
  );
}
