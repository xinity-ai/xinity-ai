import { listen } from "../db";
import { rootLogger } from "../logger";

// TODO: migration — generate just before feature merge. Extends the existing trigger
// functions from db-migration/0001_loud_stellaris.sql to also broadcast on a single
// `ai_node_changed` channel with the nodeId in the payload, so the conductor can run
// one LISTEN per process instead of one per SSE connection. SQL to land in the new
// custom migration:
//
//   CREATE OR REPLACE FUNCTION notify_ai_node_change() RETURNS TRIGGER AS $$
//   DECLARE
//     record_id uuid;
//   BEGIN
//     IF (TG_OP = 'DELETE') THEN
//       record_id := OLD.id;
//     ELSE
//       record_id := NEW.id;
//     END IF;
//     PERFORM pg_notify('ai_node:' || record_id, '{}');
//     PERFORM pg_notify('ai_node_changed', record_id::text);
//     RETURN NULL;
//   END;
//   $$ LANGUAGE plpgsql;
//
//   CREATE OR REPLACE FUNCTION notify_model_installation_change() RETURNS TRIGGER AS $$
//   BEGIN
//     IF (TG_OP = 'DELETE') THEN
//       PERFORM pg_notify('ai_node:' || OLD."node_id", '{}');
//       PERFORM pg_notify('ai_node_changed', OLD."node_id"::text);
//     ELSIF (TG_OP = 'UPDATE') THEN
//       PERFORM pg_notify('ai_node:' || NEW."node_id", '{}');
//       PERFORM pg_notify('ai_node_changed', NEW."node_id"::text);
//       IF (OLD."node_id" != NEW."node_id") THEN
//         PERFORM pg_notify('ai_node:' || OLD."node_id", '{}');
//         PERFORM pg_notify('ai_node_changed', OLD."node_id"::text);
//       END IF;
//     ELSE -- INSERT
//       PERFORM pg_notify('ai_node:' || NEW."node_id", '{}');
//       PERFORM pg_notify('ai_node_changed', NEW."node_id"::text);
//     END IF;
//     RETURN NULL;
//   END;
//   $$ LANGUAGE plpgsql;

const log = rootLogger.child({ name: "node-change-bus" });
const CHANNEL = "ai_node_changed";

type Handler = () => void;

const subscribers = new Map<string, Set<Handler>>();
let started = false;

/** Register a handler for node-change notifications. Returns an unsubscribe fn. The shared LISTEN starts on first use. */
export function subscribe(nodeId: string, handler: Handler): () => void {
  ensureStarted();
  let set = subscribers.get(nodeId);
  if (!set) {
    set = new Set();
    subscribers.set(nodeId, set);
  }
  set.add(handler);
  return () => {
    const current = subscribers.get(nodeId);
    if (!current) {
      return;
    }
    current.delete(handler);
    if (current.size === 0) {
      subscribers.delete(nodeId);
    }
  };
}

function ensureStarted(): void {
  if (started) {
    return;
  }
  started = true;
  void runPump();
}

async function runPump(): Promise<void> {
  try {
    for await (const payload of listen(CHANNEL)) {
      const nodeId = String(payload ?? "").trim();
      if (!nodeId) {
        continue;
      }
      const set = subscribers.get(nodeId);
      if (!set) {
        continue;
      }
      for (const handler of set) {
        try {
          handler();
        } catch (err) {
          log.warn({ err, nodeId }, "Subscriber handler threw");
        }
      }
    }
  } catch (err) {
    log.error({ err }, `NOTIFY ${CHANNEL} listener errored`);
  }
}
