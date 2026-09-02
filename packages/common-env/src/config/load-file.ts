import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

// Read-only on purpose. Config files are hand-owned and the CLI manages .env instead, so nothing
// here writes one back.
export function loadConfigFile(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }

  const raw = readFileSync(path, "utf-8");
  switch (extname(path).toLowerCase()) {
    case ".json":
      return JSON.parse(raw);
    case ".jsonc":
      return Bun.JSONC.parse(raw);
    default:
      return Bun.YAML.parse(raw);
  }
}
