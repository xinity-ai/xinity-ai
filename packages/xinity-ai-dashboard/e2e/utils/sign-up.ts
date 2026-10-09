import { BASE_URL, MAILHOG_API } from "./test-data";

const AUTH_HEADERS = {
  "Content-Type": "application/json",
  Origin: BASE_URL,
} as const;

type MailhogResponse = {
  items?: Array<{ Content?: { Body?: string } }>;
}

function decodeQuotedPrintable(raw: string): string {
  return raw
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, "&");
}

async function findVerificationUrl(email: string): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${MAILHOG_API}/v2/search?kind=to&query=${encodeURIComponent(email)}`);
    if (res.ok) {
      const data = (await res.json()) as MailhogResponse;
      for (const item of data?.items ?? []) {
        const match = decodeQuotedPrintable(item?.Content?.Body ?? "").match(/https?:\/\/[^\s"<>]+verify-email[^\s"<>]*/);
        if (match) {
          return match[0];
        }
      }
    }
    await Bun.sleep(500);
  }
  return null;
}

// Never signs in, because sign-ins share a rate limit of three per ten seconds with the caller's own.
export async function ensureSignedUp(user: { name: string; email: string; password: string }): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({ name: user.name, email: user.email, password: user.password }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 422 && body.includes("USER_ALREADY_EXISTS")) {
      return;
    }
    throw new Error(`Sign-up failed for ${user.email}: ${res.status} ${body}`);
  }

  // A null token means the instance requires verification. It answers an address that is already
  // registered the same way, so no verification email means the user exists from an earlier run.
  const { token } = (await res.json()) as { token: string | null };
  if (token !== null) {
    return;
  }
  const verificationUrl = await findVerificationUrl(user.email);
  if (verificationUrl) {
    await fetch(verificationUrl, { redirect: "manual" });
  }
}
