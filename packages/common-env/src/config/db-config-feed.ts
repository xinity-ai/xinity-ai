import type { PinoLike } from "../pino-like";
import type { ApplyOverrides, ConfigFeed } from "./dynamic-config";

const COALESCE_WINDOW_MS = 200;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const RECONCILE_INTERVAL_MS = 4 * 60 * 60 * 1_000;

export type DbConfigFeedDeps = {
  channel: string;
  read: () => Promise<Record<string, string>>;
  subscribe: (
    channel: string,
    onNotify: (payload: string) => void,
    onSubscribed?: () => void,
  ) => Promise<() => Promise<void>>;
  log: PinoLike;
  reconcileIntervalMs?: number;
};

type RefreshReason = "notification" | "reconcile";

export function createDbConfigFeed(deps: DbConfigFeedDeps): ConfigFeed {
  return async (apply: ApplyOverrides) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryDelayMs = INITIAL_RETRY_MS;
    let refreshing = false;
    let refreshAgain = false;
    let stopped = false;

    function clearTimer(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function queueRefreshSupersedingRetry(): void {
      clearTimer();
      timer = setTimeout(run, COALESCE_WINDOW_MS);
    }

    function queueRetry(): void {
      if (timer !== null) {
        return;
      }
      timer = setTimeout(run, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
    }

    function run(): void {
      timer = null;
      void refresh();
    }

    function logApplied(changed: string[], reason: RefreshReason): void {
      if (reason === "reconcile") {
        deps.log.warn({ changed }, "Applied drifted dynamic configuration, a notification was missed");
        return;
      }
      deps.log.info({ changed }, "Applied dynamic configuration");
    }

    async function refresh(reason: RefreshReason = "notification"): Promise<void> {
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        let overrides: Record<string, string>;
        try {
          overrides = await deps.read();
        } catch (err) {
          deps.log.error({ err }, "Failed to read dynamic configuration, retrying");
          queueRetry();
          return;
        }
        retryDelayMs = INITIAL_RETRY_MS;

        try {
          const changed = apply(overrides);
          if (changed.length > 0) {
            logApplied(changed, reason);
          }
        } catch (err) {
          deps.log.error({ err }, "Rejected dynamic configuration, keeping previous values until the next write");
        }
      } finally {
        refreshing = false;
        if (refreshAgain && !stopped) {
          refreshAgain = false;
          queueRefreshSupersedingRetry();
        }
      }
    }

    const onNotification = queueRefreshSupersedingRetry;
    const onReconnectWhereNotificationsWereLost = queueRefreshSupersedingRetry;
    const unlisten = await deps.subscribe(
      deps.channel,
      onNotification,
      onReconnectWhereNotificationsWereLost,
    );
    const reconcileTimer = setInterval(
      () => void refresh("reconcile"),
      deps.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS,
    );

    return async () => {
      stopped = true;
      clearTimer();
      clearInterval(reconcileTimer);
      try {
        await unlisten();
      } catch (err) {
        deps.log.warn({ err }, "Failed to unlisten from dynamic configuration");
      }
    };
  };
}
