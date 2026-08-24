import { homedir, tmpdir } from "os";
import { join } from "path";

export const IS_WINDOWS = process.platform === "win32";

export const SUPPORTS_SSH_MULTIPLEXING = !IS_WINDOWS;

const PLATFORM_MAP: Record<string, string> = {
  linux: "linux",
  darwin: "darwin",
  win32: "windows",
};

const PLATFORM_LABELS: Record<string, string> = {
  linux: "Linux",
  darwin: "macOS",
  win32: "Windows",
};

const ARCH_MAP: Record<string, string> = {
  x64: "x64",
  arm64: "arm64",
};

export function cliAssetSuffix(): string {
  const platform = PLATFORM_MAP[process.platform];
  if (!platform) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  const arch = ARCH_MAP[process.arch] ?? "x64";
  return `${platform}-${arch}`;
}

export function platformLabel(): string {
  return PLATFORM_LABELS[process.platform] ?? process.platform;
}

export function configDir(): string {
  if (IS_WINDOWS) {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "xinity");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "xinity");
}

export function defaultInstallDir(): string {
  if (IS_WINDOWS) {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "xinity");
  }
  return join(homedir(), ".local", "bin");
}

export function binaryName(): string {
  return IS_WINDOWS ? "xinity.exe" : "xinity";
}

export function sshSocketPath(hostname: string): string {
  return join(tmpdir(), `xinity-ssh-${hostname}`);
}
