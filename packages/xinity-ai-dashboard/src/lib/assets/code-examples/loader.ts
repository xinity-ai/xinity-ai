const API_BASE_PLACEHOLDER = "{{API_BASE}}";

const rawFiles = import.meta.glob("./**/*.{py,js,sh}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

export type Language = "python" | "javascript" | "bash";

export interface CodeExampleSet {
  python?: string;
  javascript?: string;
  bash?: string;
}

const extToLang: Record<string, Language> = {
  ".py": "python",
  ".js": "javascript",
  ".sh": "bash",
};

function buildExampleMap(
  apiBase: string,
  prefix: string,
): Record<string, CodeExampleSet> {
  const map: Record<string, CodeExampleSet> = {};

  for (const [path, content] of Object.entries(rawFiles)) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    const parts = relative.split("/");
    if (parts.length !== 2) continue;

    const dir = parts[0];
    const filename = parts[1];
    const ext = filename.substring(filename.lastIndexOf("."));
    const lang = extToLang[ext];

    if (!dir || !lang) continue;

    if (!map[dir]) map[dir] = {};
    map[dir]![lang] = content.replaceAll(API_BASE_PLACEHOLDER, apiBase);
  }

  return map;
}

export function getExamples(apiBase: string): Record<string, CodeExampleSet> {
  const all = buildExampleMap(apiBase, "./");
  // Exclude api-keys subdirectory
  delete all["api-keys"];
  return all;
}

export function getApiKeyExamples(apiBase: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [path, content] of Object.entries(rawFiles)) {
    if (!path.startsWith("./api-keys/")) continue;
    const filename = path.split("/").pop()!;
    const key = filename.substring(0, filename.lastIndexOf("."));
    result[key] = content.replaceAll(API_BASE_PLACEHOLDER, apiBase);
  }
  return result;
}
