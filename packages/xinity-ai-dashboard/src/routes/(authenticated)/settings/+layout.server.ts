import { eq, userT } from "common-db";
import { error } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";
import { getDB } from "$lib/server/db";

export const load: LayoutServerLoad = async ({ parent }) => {
  const { user } = await parent();

  const [fullUser] = await getDB()
    .select()
    .from(userT)
    .where(eq(userT.id, user.id))
    .limit(1);
  if (!fullUser) error(500, "Authenticated user not found in database");
  return { fullUser };
};
