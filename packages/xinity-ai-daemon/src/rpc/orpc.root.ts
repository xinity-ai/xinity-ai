import { os } from "@orpc/server";

export const privateProcedure = os.$context<{ headers: Headers }>();
