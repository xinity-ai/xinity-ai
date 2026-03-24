import { error, redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { eq, userT } from "common-db";
import { rootLogger } from "$lib/server/logging";
import { getDB } from "$lib/server/db";
import { auth } from "$lib/server/auth-server";

const log = rootLogger.child({ name: "login.update" });

/*
This endpoint exists as a post signup step, where profile information, that is
submitted at signup, is added to the database.  

The flow is as follows:
- User signs up
- They receive a email with the link that will validate their mail, and sign them in
- They are redirected here, with the relevant profile information
- The profile information is saved to the db
- The user is redirected to the final destination 
 */

export const GET: RequestHandler = async ({ url, locals, request }) => {
  const session = await auth.api.getSession(request);
  if (!session) {
    error(403, "Not authorized");
  }
  const callback = url.searchParams.get("callbackUrl");
  const name = url.searchParams.get("name");

  log.info({ callback, user: { name, id: session.user.id } }, "Entered user name");

  if (name) {
    await getDB().update(userT).set({ name }).where(eq(userT.id, session.user.id));
  }

  redirect(302, callback || "/");
};
