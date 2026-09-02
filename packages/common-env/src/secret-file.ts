import { readFileSync } from "node:fs";

export function readSecretFile(path: string, key: string): string {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch (err) {
    throw new Error(
      `Failed to read secret file for ${key} from "${path}": ${(err as Error).message}`,
      { cause: err },
    );
  }
}
