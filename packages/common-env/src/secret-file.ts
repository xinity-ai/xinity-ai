import { readFileSync } from "node:fs";

export type SecretFileReader = (path: string, envKey: string) => string;

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

export function cachingSecretFileReader(): SecretFileReader {
  const contentsByPath = new Map<string, string>();
  return (path, envKey) => {
    let contents = contentsByPath.get(path);
    if (contents === undefined) {
      contents = readSecretFile(path, envKey);
      contentsByPath.set(path, contents);
    }
    return contents;
  };
}
