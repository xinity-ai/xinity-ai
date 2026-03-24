/**
 * Browser-side logger that forwards selected events to the server `/log` endpoint.
 */
import { browser } from "$app/environment";
import { default as pino } from "pino";

/**
 * Sends client logs to the server and keeps a local console trail.
 */
export const browserLogger = pino({
  browser: {
    serialize: true,
    transmit: {
      level: "info",
      send(level, event) {
        if (!browser) return;
        fetch("/log", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ level, messages: event.messages, ts: event.ts }),
        }).catch((e) => console.error("Failed to send logging message", e));
      },
    },
  },
});
