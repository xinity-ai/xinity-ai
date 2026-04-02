/**
 * Env file parsing and serialization utilities.
 *
 * Pure I/O helpers with no UI dependencies. Safe to import from any module.
 */
import { existsSync, readFileSync } from "fs";

/** Parse env file content (KEY=value lines) into a key-value record. */
export function parseEnvString(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Read an existing env file into a key-value record. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnvString(readFileSync(path, "utf-8"));
}

/** Serialize a key-value record to .env file format. */
export function serializeEnvFile(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([k, v]) => {
        // Quote values that contain spaces or special chars
        if (/[\s#"']/.test(v)) return `${k}="${v}"`;
        return `${k}=${v}`;
      })
      .join("\n") + "\n"
  );
}

/** Read existing secret files from a directory into a key-value record. */
export function readSecretFiles(dir: string, keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const path = `${dir}/${key}`;
    if (existsSync(path)) {
      try {
        result[key] = readFileSync(path, "utf-8").trim();
      } catch { /* skip unreadable secrets */ }
    }
  }
  return result;
}
