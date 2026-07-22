import type { SpinnerResult } from "@clack/prompts";
import { log, spinner as clackSpinner } from "./clack.ts";
import { dim } from "picocolors";
import { pass, fail, warn, info } from "./output.ts";
import type { StepEvent } from "./step-event.ts";

export interface Progress {
  /** Transient: only updates the spinner text. */
  update(message: string): void;
  /** Persists; the spinner pauses around it. */
  warn(label: string, detail?: string, hint?: string): void;
  /** Persists; the first failure replays the transient trail for context. */
  fail(label: string, detail?: string): void;
  hasFailed(): boolean;
  /** One persistent summary line for the whole scope; suppressed after a failure. */
  done(summary: string): void;
  /** Safety net for early exits: never leave the spinner running. */
  ensureSettled(): void;
}

export function createSilentProgress(): Progress {
  let failed = false;
  return {
    update() {},
    warn() {},
    fail() { failed = true; },
    hasFailed: () => failed,
    done() {},
    ensureSettled() {},
  };
}

/**
 * Collapses a stream of mechanical steps into one live spinner: successes
 * only update the spinner text, warnings persist, and the first failure
 * replays the transient trail so the error keeps its context. `done()`
 * leaves exactly one persistent line for the whole scope.
 */
export function createProgress(start: string): Progress {
  let spinner = clackSpinner();
  const trail: string[] = [];
  let lastMessage = start;
  let failed = false;
  let finished = false;

  spinner.start(start);

  const pause = () => spinner.stop(dim(lastMessage));
  const resume = () => {
    spinner = clackSpinner();
    spinner.start(lastMessage);
  };

  return {
    update(message) {
      if (failed) {
        log.info(dim(message));
        return;
      }
      trail.push(message);
      lastMessage = message;
      spinner.message(message);
    },

    warn(label, detail, hint) {
      if (!failed) {
        pause();
      }
      warn(label, detail);
      if (hint) {
        log.info(dim(hint));
      }
      if (!failed) {
        resume();
      }
    },

    fail(label, detail) {
      if (!failed) {
        pause();
        if (trail.length > 0) {
          log.message(trail.map((line) => dim(line)));
        }
        failed = true;
      }
      fail(label, detail);
    },

    hasFailed: () => failed,

    done(summary) {
      if (failed || finished) return;
      finished = true;
      spinner.stop(summary);
    },

    ensureSettled() {
      if (failed || finished) return;
      finished = true;
      spinner.stop(dim(lastMessage));
    },
  };
}

function renderToProgress(event: StepEvent, progress: Progress): void {
  switch (event.type) {
    case "pass":
    case "info": {
      progress.update(event.detail ?? event.label);
      break;
    }
    case "warn": {
      progress.warn(event.label, event.detail);
      break;
    }
    case "fail": {
      progress.fail(event.label, event.detail);
      break;
    }
    case "spinner": {
      if (event.message) {
        progress.update(event.message);
      }
      break;
    }
    case "log": {
      progress.update(event.message);
      break;
    }
  }
}

function renderEvent(event: StepEvent, spinners: Map<string, SpinnerResult>): void {
  switch (event.type) {
    case "pass": {
      pass(event.label, event.detail);
      break;
    }
    case "fail": {
      fail(event.label, event.detail);
      break;
    }
    case "warn": {
      warn(event.label, event.detail);
      break;
    }
    case "info": {
      info(event.label, event.detail);
      break;
    }
    case "spinner": {
      const existing = spinners.get(event.id);
      if (event.done) {
        existing?.stop(event.message);
        spinners.delete(event.id);
      } else if (existing) {
        if (event.message) {
          existing.message(event.message);
        }
      } else {
        const s = clackSpinner();
        s.start(event.message ?? "");
        spinners.set(event.id, s);
      }
      break;
    }
    case "log": {
      log.info(event.message);
      break;
    }
  }
}

export async function runSteps<T>(gen: AsyncGenerator<StepEvent, T>, progress?: Progress): Promise<T> {
  if (progress) {
    let result = await gen.next();
    while (!result.done) {
      renderToProgress(result.value, progress);
      result = await gen.next();
    }
    return result.value;
  }

  const spinners = new Map<string, SpinnerResult>();
  try {
    let result = await gen.next();
    while (!result.done) {
      renderEvent(result.value, spinners);
      result = await gen.next();
    }
    return result.value;
  } finally {
    for (const s of spinners.values()) {
      s.stop();
    }
    spinners.clear();
  }
}

/** Run a step stream inside its own collapsed scope with a single summary line. */
export async function runStepsCollapsed<T>(
  gen: AsyncGenerator<StepEvent, T>,
  start: string,
  summary: string,
): Promise<T> {
  const progress = createProgress(start);
  const result = await runSteps(gen, progress);
  progress.done(summary);
  return result;
}

export async function collectSteps<T>(gen: AsyncGenerator<StepEvent, T>): Promise<{ events: StepEvent[]; result: T }> {
  const events: StepEvent[] = [];
  let result = await gen.next();
  while (!result.done) {
    events.push(result.value);
    result = await gen.next();
  }
  return { events, result: result.value };
}
