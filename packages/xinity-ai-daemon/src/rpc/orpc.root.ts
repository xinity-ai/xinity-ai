import { os } from "@orpc/server";

const o = os.$context<{ headers: Headers }>();

export const privateProcedure = o
