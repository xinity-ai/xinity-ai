export async function formatErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.message) {
      return String(parsed.error.message);
    }
  } catch {
    // raw text fallback below
  }
  return text || `Request failed (${res.status})`;
}
