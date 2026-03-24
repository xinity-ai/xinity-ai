/**
 * Custom route param matcher for UUID segments.
 */
import { z } from "zod";

const uuid = z.string().uuid();
/**
 * Validates a route parameter as a UUID for `[param=uuid]` routes.
 */
export function match(param: string) {
  const result = uuid.safeParse(param);
  return result.success;
}
