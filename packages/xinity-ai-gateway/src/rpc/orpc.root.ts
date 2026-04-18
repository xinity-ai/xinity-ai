import { os } from "@orpc/server";
import { z } from "zod";

const o = os.$context<{ headers: Headers }>();

export const privateProcedure = o
  .errors({
    UNAUTHORIZED: { data: z.string(), status: 403 },
  })
  .use(({ context, next, errors }) => {
    const authorization = context.headers.get("x-apikey");
    if (authorization !== Bun.env.SECRET_TOKEN) {
      throw errors.UNAUTHORIZED({ data: "Token not matching" });
    }
    return next();
  });
