import { timingSafeEqual } from "node:crypto";
import { env } from "./env";

const secretBuffer = Buffer.from(env.TETHER_SECRET);

export function verifyBearerToken(req: Request): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return false;
  }
  const token = Buffer.from(header.slice(7));
  if (token.length !== secretBuffer.length) {
    return false;
  }
  return timingSafeEqual(token, secretBuffer);
}

export function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}
