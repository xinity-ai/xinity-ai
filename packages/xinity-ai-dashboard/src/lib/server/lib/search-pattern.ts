export function searchPattern(query: string): string {
  return `%${query.trim().replace(/[%_\\]/g, "\\$&")}%`;
}
