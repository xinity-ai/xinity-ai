import { rootOs, withAuth } from "../root";
import { UserDto } from "$lib/orpc/dtos/user.dto";
import { commonInputFilter } from "$lib/orpc/dtos/common.dto";
import { sql, userT } from "common-db";
import z from "zod";
import { getDB } from "$lib/server/db";
import { rootLogger } from "$lib/server/logging";

const tags = ["User"];
const log = rootLogger.child({ name: "api.user" });

/**
 * Return the authenticated user's full record.
 */
const getSelf = rootOs.use(withAuth)
  .route({
    method: "GET", path: "/self", tags, summary: "Get Self",
    description: "Endpoint to obtain a available info about your own user",
  })
  .output(UserDto)
  .handler(async ({ context, errors }): Promise<z.infer<typeof UserDto>> => {
    const userId = context.session.user.id;
    const [user] = await getDB().select().from(userT).where(sql`${userT.id} = ${userId}`).limit(1);
    if (!user) throw errors.NOT_FOUND({ message: "User not found" });
    return user;
  });

/**
 * Update profile settings for the authenticated user.
 */
const updateSettings = rootOs
  .use(withAuth)
  .route({
    summary: "Update User Settings",
    path: "/self", method: "PATCH", tags, description: `Endpoint to update your own user
This focuses on settings and the name of the user` })
  .input(UserDto.omit(commonInputFilter).partial().omit({ id: true }))
  .output(UserDto)
  .handler(async ({ context, input, errors }) => {
    const userID = context.session.user.id;
    const [user] = await getDB()
      .update(userT)
      .set(input)
      .where(sql`${userT.id} = ${userID}`).returning();
    if (!user) throw errors.INTERNAL_SERVER_ERROR({ message: "Failed to update user" });
    return user;
  });

export const userRouter = rootOs.prefix("/user").router({
  getSelf,
  updateSettings,
});
