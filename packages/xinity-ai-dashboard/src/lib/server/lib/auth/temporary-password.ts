import { getDB } from "$lib/server/db";
import { userT, sql } from "common-db";

export const TEMPORARY_PASSWORD_MESSAGE = "Change your temporary password first";

export async function hasTemporaryPassword(userId: string): Promise<boolean> {
  const [row] = await getDB()
    .select({ temporaryPassword: userT.temporaryPassword })
    .from(userT)
    .where(sql`${userT.id} = ${userId}`)
    .limit(1);
  return row?.temporaryPassword ?? false;
}

export async function clearTemporaryPassword(userId: string): Promise<void> {
  await getDB().update(userT).set({ temporaryPassword: false }).where(sql`${userT.id} = ${userId}`);
}
