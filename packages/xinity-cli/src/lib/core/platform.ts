import { homedir, tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// x64 release builds need AVX2 (Haswell or newer). x64-baseline runs on any x86-64 CPU.
export type HostArch = "x64" | "x64-baseline" | "arm64";

const MACHINE_ARCH: Record<string, "x64" | "arm64"> = {
  x64: "x64",
  x86_64: "x64",
  amd64: "x64",
  arm64: "arm64",
  aarch64: "arm64",
};

export function hostArch(machine: string, hasAvx2: boolean): HostArch {
  const arch = MACHINE_ARCH[machine];
  if (!arch) {
    throw new Error(`Unsupported architecture: ${machine || "unknown"} (supported: x86_64, aarch64)`);
  }
  return arch === "x64" && !hasAvx2 ? "x64-baseline" : arch;
}

function localCpuHasAvx2(): boolean {
  try {
    return /^flags\s*:.*\bavx2\b/m.test(readFileSync("/proc/cpuinfo", "utf8"));
  } catch {
    return false;
  }
}

export function localArch(): HostArch {
  return hostArch(process.arch, process.platform !== "linux" || localCpuHasAvx2());
}

export function cliAssetSuffix(): string {
  const platform = PLATFORM_MAP[process.platform];
  if (!platform) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  return `${platform}-${localArch()}`;
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
