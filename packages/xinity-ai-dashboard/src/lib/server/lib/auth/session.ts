import { error } from "@sveltejs/kit";
import { auth, type Session } from "$lib/server/auth-server";
import { hasTemporaryPassword, TEMPORARY_PASSWORD_MESSAGE } from "./temporary-password";

export async function requireSession(headers: Headers): Promise<Session> {
  const session = await auth.api.getSession({ headers });
  if (!session) {
    error(401, "Unauthorized");
  }
  if (await hasTemporaryPassword(session.user.id)) {
    error(403, TEMPORARY_PASSWORD_MESSAGE);
  }
  return session;
}
