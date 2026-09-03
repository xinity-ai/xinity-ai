import { timingSafeEqual } from "node:crypto";
import { config } from "./config";

const secretBuffer = Buffer.from(config.tetherSecret);

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
