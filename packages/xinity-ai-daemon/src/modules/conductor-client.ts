import type { StatusReport } from "common-env";
import { env } from "../env";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "conductor-client" });

/**
 * True when the daemon has both the conductor URL and a runner token. Dual-write is silently disabled otherwise.
 */
export function conductorConfigured(): boolean {
  return Boolean(env.CONDUCTOR_URL && env.RUNNER_TOKEN);
}

/** Send a status report to the conductor. Errors are logged and swallowed — PG is still the source of truth in dual-write mode. */
export async function reportStatus(report: StatusReport): Promise<void> {
  if (!conductorConfigured()) {
    return;
  }
  try {
    const res = await fetch(`${env.CONDUCTOR_URL}/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RUNNER_TOKEN}`,
      },
      body: JSON.stringify(report),
    });
    if (!res.ok) {
      log.warn({ status: res.status, body: await res.text().catch(() => "") }, "Conductor rejected status report");
    }
  } catch (err) {
    log.warn({ err }, "Conductor unreachable");
  }
}
