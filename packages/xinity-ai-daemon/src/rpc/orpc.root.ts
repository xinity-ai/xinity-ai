import type { IncomingHttpHeaders } from "node:http2";
import { os } from "@orpc/server";

const o = os.$context<{ headers: IncomingHttpHeaders }>();

export const privateProcedure = o
