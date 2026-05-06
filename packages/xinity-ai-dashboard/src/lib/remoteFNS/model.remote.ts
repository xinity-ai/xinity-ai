/**
 * Remote model helpers for authenticated requests.
 */
import { getRequestEvent, query } from "$app/server";
import { error } from "@sveltejs/kit";
import { auth } from "../server/auth-server";
import z from "zod";
import { infoClient } from "$lib/server/info-client";


/** Resolves the current session or throws when unauthenticated. */
async function getRemoteSession() {
  const { locals, } = getRequestEvent();
  const session = await auth.api.getSession(locals.request);
  if (!session) {
    throw error(407, "Not logged in")
  }
  return session;
}

/** Resolves a single model's full metadata by public specifier. */
export const getModelInfoR = query(z.string(), async (specifier) => {
  await getRemoteSession();
  return await infoClient?.fetchModel({ kind: "canonical", specifier }) ?? null;
});
