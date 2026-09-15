import { z } from "zod";
import type { ApplyOverrides, ConfigFeed } from "common-env";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "config-feed" });

const configEventSchema = z.object({ values: z.record(z.string(), z.string()) });

let apply: ApplyOverrides | null = null;

/** The daemon has no database, so its values arrive on the tether's SSE stream. */
export const tetherConfigFeed: ConfigFeed = async (applyOverrides) => {
  apply = applyOverrides;
  return async () => {
    apply = null;
  };
};

export function receiveConfigEvent(data: string): void {
  if (!apply) {
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    log.warn("Malformed JSON in config event");
    return;
  }

  const parsed = configEventSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn({ error: parsed.error.message }, "Invalid config payload");
    return;
  }

  try {
    const changed = apply(parsed.data.values);
    if (changed.length > 0) {
      log.info({ changed }, "Applied dynamic configuration");
    }
  } catch (err) {
    log.error({ err }, "Rejected dynamic configuration, keeping previous values until the next change");
  }
}
