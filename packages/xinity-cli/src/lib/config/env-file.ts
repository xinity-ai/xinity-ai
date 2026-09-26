
/** Parse env file content (KEY=value lines) into a key-value record. */
export function parseEnvString(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Serialize a key-value record to .env file format. */
export function serializeEnvFile(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([k, v]) => `${k}=${quoteEnvValue(v)}`)
      .join("\n") + "\n"
  );
}

function quoteEnvValue(value: string): string {
  if (!/[\s#"']/.test(value)) return value;
  if (value.includes('"') && !value.includes("'")) return `'${value}'`;
  return `"${value.replace(/"/g, '\\"')}"`;
}
