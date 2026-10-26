import { reportDeprecations, type DeprecationChecks } from "./deprecations";
import { authHeaderMatches, type MetricsCredential } from "./metrics-auth";
import type { PinoLike } from "./pino-like";

/** Null while the dependency is fine, otherwise a short description of what is wrong. */
export type HealthCheck = () => string | null;

export type DependencyProbe = {
  check: HealthCheck;
  probeNow: () => Promise<void>;
  /** Restarts the probe loop, so a changed interval takes effect at once. */
  start: (intervalMs?: number) => void;
  stop: () => void;
};

/**
 * Starts out reachable: every caller has already reached the dependency at boot, and
 * readiness must not wait one interval for the first probe.
 */
export function createDependencyProbe(opts: {
  name: string;
  ping: () => Promise<unknown>;
  log: PinoLike;
  onUnreachable?: () => void;
}): DependencyProbe {
  let reachable = true;
  let probing = false;
  let timer: Timer | undefined;

  async function probeNow(): Promise<void> {
    if (probing) {
      return;
    }
    probing = true;
    try {
      await opts.ping();
      if (!reachable) {
        opts.log.info({ dependency: opts.name }, `${opts.name} reachable again`);
      }
      reachable = true;
    } catch (err) {
      if (reachable) {
        opts.log.error({ err, dependency: opts.name }, `${opts.name} unreachable`);
        opts.onUnreachable?.();
      }
      reachable = false;
    } finally {
      probing = false;
    }
  }

  function stop(): void {
    clearInterval(timer);
    timer = undefined;
  }

  return {
    check: () => (reachable ? null : "unreachable"),
    probeNow,
    start(intervalMs = 10_000) {
      stop();
      timer = setInterval(() => void probeNow(), intervalMs);
    },
    stop,
  };
}

export type HealthOptions = {
  /** Any failing check answers 503. */
  readiness: Record<string, HealthCheck>;
  /** Reported in the detail view only. The service keeps serving without these. */
  degraded?: Record<string, HealthCheck>;
  details?: () => Record<string, unknown>;
  deprecations?: DeprecationChecks;
  /** METRICS_AUTH. With none configured the detail view is never served. */
  credentials: MetricsCredential[];
};

const NO_STORE = { "Cache-Control": "no-store" };

function evaluate(checks: Record<string, HealthCheck>): Record<string, string> {
  return Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, check() ?? "ok"]));
}

export type ListenTarget = { host?: string; port?: number; unixSocket?: string; tls: boolean };

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/** The address to reach a service bound to `bind` from its own machine. */
export function reachableLocalHost(bind: string | undefined): string {
  return !bind || WILDCARD_HOSTS.has(bind) ? "127.0.0.1" : bind;
}

/** A request to the instance listening on `target`, from the same machine. */
export function localRequest(target: ListenTarget, path: string): { url: string; init: { unix?: string; tls?: { rejectUnauthorized: false } } } {
  const scheme = target.tls ? "https" : "http";
  return {
    url: target.unixSocket ? `${scheme}://localhost${path}` : `${scheme}://${reachableLocalHost(target.host)}:${target.port}${path}`,
    init: {
      unix: target.unixSocket,
      // The instance serves its own certificate, so there is nothing to verify it against.
      tls: target.tls ? { rejectUnauthorized: false } : undefined,
    },
  };
}

/** Asks a running instance on this machine for its `/health`. True only on a 200. */
export async function probeOwnHealth(target: ListenTarget): Promise<boolean> {
  const { url, init } = localRequest(target, "/health");
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** The container healthcheck: images ship no curl, so the binary run with `--health` asks the running instance itself. */
export async function exitOnHealthFlag(target: ListenTarget): Promise<void> {
  if (Bun.argv.includes("--health")) {
    process.exit(await probeOwnHealth(target) ? 0 : 1);
  }
}

export function createHealthHandler(opts: HealthOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    const readiness = evaluate(opts.readiness);
    const ok = Object.values(readiness).every((result) => result === "ok");
    const init = { status: ok ? 200 : 503, headers: NO_STORE };

    const showDetails = opts.credentials.length > 0
      && authHeaderMatches(opts.credentials, req.headers.get("authorization"));
    if (!showDetails) {
      return Response.json({ ok }, init);
    }
    const checks = { ...readiness, ...evaluate(opts.degraded ?? {}) };
    const deprecations = await reportDeprecations(opts.deprecations ?? {});
    return Response.json({ ...opts.details?.(), ok, checks, deprecations }, init);
  };
}
