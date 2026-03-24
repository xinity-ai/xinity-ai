import {
  Subject,
  Observable,
  Subscription,
  merge,
  timer,
  defer,
  from,
  EMPTY,
} from "rxjs";
import {
  catchError,
  concatMap,
  map,
  scan,
  share,
  filter,
} from "rxjs/operators";
import { rootLogger } from "../logger";

const log = rootLogger.child({ name: "sync-coordinator" });

export type WorkflowTrigger =
  | { kind: "interval" }
  | { kind: "signal"; source?: string };

export interface WorkflowCoordinatorOptions {
  /**
   * The interval between periodic workflow triggers, in milliseconds.
   * Use something like: 6 * 60 * 60 * 1000 for every 6 hours.
   */
  periodMs: number;

  /**
   * The workflow to run. It is executed with "no overlap" and at most one queued run.
   * Errors are swallowed by default (and sent to onError) to keep the service alive 24/7.
   */
  run: (trigger: WorkflowTrigger) => Promise<void> | Observable<void>;

  /**
   * Optional error hook for logging/metrics.
   */
  onError?: (err: unknown, trigger: WorkflowTrigger) => void;

  /**
   * Optional hook invoked when a trigger is dropped because the queue is full.
   */
  onDrop?: (trigger: WorkflowTrigger) => void;
}

export interface WorkflowCoordinator {
  /**
   * Push a signal-trigger into the coordinator.
   */
  signal: (source?: string) => void;

  /**
   * Starts the coordinator and returns a Subscription you can unsubscribe on shutdown.
   */
  start: () => Subscription;
}

/**
 * Creates an RxJS-based workflow coordinator that merges an interval trigger with
 * ad-hoc signal triggers, runs the workflow with no overlap, and enforces a maximum
 * queue capacity of 2 total (1 running + 1 queued).
 *
 * Semantics:
 * - If idle: the next trigger starts a run immediately.
 * - If running and no queued run: the next trigger is queued (exactly one).
 * - If running and a queued run already exists: further triggers are dropped.
 */
export function createWorkflowCoordinator(
  options: WorkflowCoordinatorOptions
): WorkflowCoordinator {
  const { periodMs, run, onError, onDrop } = options;

  const signal$ = new Subject<WorkflowTrigger>();
  const done$ = new Subject<GateEvent>();

  const interval$ = timer(0, periodMs).pipe(map(() => ({ kind: "interval" } as const)));

  const incoming$: Observable<WorkflowTrigger | GateEvent> = merge(interval$, signal$, done$);

  type GateState =
    | { mode: "idle" }
    | { mode: "running"; queued: boolean };

  type GateEvent =
    | { type: "accept"; trigger: WorkflowTrigger }
    | { type: "drop"; trigger: WorkflowTrigger }
    | { type: "done" };

  const gated$ = incoming$.pipe(
    scan<WorkflowTrigger | GateEvent, { state: GateState; out?: GateEvent }>(
      (acc, item) => {
        const ev = isGateEvent(item) ? item : null;

        if (ev?.type === "done") {
          if (acc.state.mode === "running" && acc.state.queued) {
            return { state: { mode: "running", queued: false }, out: { type: "accept", trigger: { kind: "signal", source: "queued" } } };
          }
          return { state: { mode: "idle" } };
        }

        const trigger = ev ? ev.trigger : (item as WorkflowTrigger);

        if (acc.state.mode === "idle") {
          return { state: { mode: "running", queued: false }, out: { type: "accept", trigger } };
        }

        if (acc.state.mode === "running" && !acc.state.queued) {
          return { state: { mode: "running", queued: true }, out: { type: "accept", trigger } };
        }

        return { state: acc.state, out: { type: "drop", trigger } };
      },
      { state: { mode: "idle" } }
    ),
    map((x) => x.out),
    filter((x): x is GateEvent => Boolean(x)),
    share()
  );

  const acceptedTriggers$ = gated$.pipe(
    filter((e) => e.type === "accept"),
    map((e) => e.trigger)
  );

  const dropped$ = gated$.pipe(
    filter((e) => e.type === "drop"),
    map((e) => e.trigger),
    share()
  );

  function start(): Subscription {
    const sub = new Subscription();

    sub.add(
      acceptedTriggers$
        .pipe(
          concatMap((trigger) =>
            defer(() => from(run(trigger))).pipe(
              catchError((err) => {
                onError?.(err, trigger);
                return EMPTY;
              }),
              concatMap(() => {
                done$.next({ type: "done" });
                return EMPTY;
              })
            )
          )
        )
        .subscribe()
    );

    sub.add(
      dropped$.subscribe((trigger) => {
        log.warn({ trigger }, "Workflow trigger dropped (queue full)");
        onDrop?.(trigger);
      })
    );

    return sub;
  }

  function signal(source?: string): void {
    signal$.next({ kind: "signal", source });
  }

  return {
    signal,
    start,
  };
}

function isGateEvent(x: unknown): x is { type: string } {
  return typeof x === "object" && x !== null && "type" in x;
}
