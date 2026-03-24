/**
 * Receives browser log events and forwards them to the server logger.
 * Disables the corresponding client transmit when removing this route.
 */

import { z } from "zod";
import type { RequestHandler } from "./$types";
import { error } from "@sveltejs/kit";
import { rootLogger } from "$lib/server/logging";

const log = rootLogger.child({ name: "browser" });

const logSchema = z.object({
  level: z.enum(["debug", "trace", "error", "warn", "fatal", "info"]),
  messages: z.tuple([z.record(z.string(), z.any()), z.string()]).or(z.tuple([z.string()])),
  ts: z.number(),
});
/** Handles log ingestion from the browser logger. */
export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json();
  const logs = logSchema.safeParse(body);
  if (!logs.success) {
    log.warn({ issues: logs.error.issues }, "Invalid browser log request");
    error(400, { message: "Invalid log request" });
  }
  if (logs.data && logs.data.messages.length > 1) {
    const obj = logs.data.messages[0] as Record<string, any>;
    if ("name" in obj) {
      obj.name = `browser.${obj.name}`;
    }
    log[logs.data.level](obj, logs.data.messages[1]);
  } else if (logs.data) {
    log[logs.data.level](logs.data.messages[0]);
  }

  return new Response("Ok");
};
