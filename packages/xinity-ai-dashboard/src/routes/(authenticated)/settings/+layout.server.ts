import { sql, userT } from "common-db";
import type { LayoutServerLoad } from "./$types";
import { getDB } from "$lib/server/db";

export const load: LayoutServerLoad = async ({ parent }) => {
  const { user } = await parent();

  const [fullUser] = await getDB()
    .select()
    .from(userT)
    .where(sql`${userT.id} = ${user.id}`)
    .limit(1);
  return { fullUser };
};
