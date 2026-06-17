export async function formatErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    // Gateway / OpenAI-style error body.
    if (parsed?.error?.message) {
      return String(parsed.error.message);
    }
    // SvelteKit error() and the dashboard's handleError use { message, traceId? }.
    if (typeof parsed?.message === "string") {
      return parsed.message;
    }
    // Some backends report the reason under { detail }.
    if (typeof parsed?.detail === "string") {
      return parsed.detail;
    }
  } catch {
    // raw text fallback below
  }
  return text || `Request failed (${res.status})`;
}
