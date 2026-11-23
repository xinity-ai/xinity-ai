import { BIN_DIR, SECRETS_DIR, binaryBaseName, type Component } from "../core/component-meta.ts";

export const LAUNCH_DAEMONS_DIR = "/Library/LaunchDaemons";

export function launchdLabel(component: Component): string {
  return `ai.xinity.${component}`;
}

export function launchdLogPath(component: Component): string {
  return `/var/log/xinity-ai-${component}.log`;
}

export function stateDirOf(component: Component): string {
  return `/var/lib/xinity-ai-${component}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const string = (value: string) => `<string>${escapeXml(value)}</string>`;

// launchd has no environment file, so the configuration lives in the job itself. Secrets stay
// in root-only files the service reads through common-env's KEY_FILE resolution.
export function generatePlist(component: Component, config: Record<string, string>, secretKeys: string[]): string {
  const environment = {
    ...config,
    ...Object.fromEntries(secretKeys.map((key) => [`${key}_FILE`, `${SECRETS_DIR}/${key}`])),
  };
  const logPath = launchdLogPath(component);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  ${string(launchdLabel(component))}`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    ${string(`${BIN_DIR}/${binaryBaseName(component)}`)}`,
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries(environment).flatMap(([key, value]) => [`    <key>${escapeXml(key)}</key>`, `    ${string(value)}`]),
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  ${string(stateDirOf(component))}`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    `  <key>StandardOutPath</key>`,
    `  ${string(logPath)}`,
    `  <key>StandardErrorPath</key>`,
    `  ${string(logPath)}`,
    `</dict>`,
    `</plist>`,
  ].join("\n") + "\n";
}
