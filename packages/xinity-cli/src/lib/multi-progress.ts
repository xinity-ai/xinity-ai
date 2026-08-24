/**
 * Multi-line progress tree for concurrent tasks.
 *
 * Renders a parent spinner with indented child rows, one per task.
 * Each row animates independently and settles (success/failure) as its
 * task completes. The parent spinner keeps animating until every child
 * has settled, then the whole tree freezes in place as static output.
 *
 * On a TTY the tree redraws in place using ANSI cursor movement.
 * In CI or piped output, each slot emits a single line when it settles.
 *
 * Usage:
 *
 *   const multi = createMultiProgress({
 *     message: "Deploying to 3 hosts",
 *     slots: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
 *   });
 *
 *   await mapBounded(hosts, 8, async (host) => {
 *     const slot = multi.slot(host.address);
 *     slot.update("installing daemon");
 *     // ... work ...
 *     slot.done("applied");
 *   });
 *
 *   multi.done();
 *
 * Each slot conforms to the Progress interface from step-runner.ts,
 * so it can be passed to any function that accepts a Progress handle.
 * Use createDoneGuard(slot) when passing to functions that call
 * progress.done() internally (like applyComponentAction), so the
 * per-component done() does not prematurely settle the host slot.
 */

import { dim, green, red, magenta } from "picocolors";
import { createSilentProgress, type Progress } from "./step-runner.ts";

const SPINNER_FRAMES = ["◒", "◐", "◓", "◑"];
const S_SUCCESS = "◆";
const S_ERROR = "■";
const S_BAR = "├";
const S_BAR_END = "└";

type SlotState = {
  label: string;
  message: string;
  settled: boolean;
  failed: boolean;
}

export type MultiProgressResult = {
  slot(label: string): Progress;
  done(): void;
}

export function createDoneGuard(target: Progress): Progress {
  return {
    update: (msg) => target.update(msg),
    warn: (label, detail, hint) => target.warn(label, detail, hint),
    fail: (label, detail) => target.fail(label, detail),
    hasFailed: () => target.hasFailed(),
    done() {},
    ensureSettled() {},
  };
}

export function createMultiProgress(opts: {
  message: string;
  slots: string[];
}): MultiProgressResult {
  const out = process.stderr;
  const isTTY = out.isTTY === true;

  const states: SlotState[] = opts.slots.map((label) => ({
    label,
    message: label,
    settled: false,
    failed: false,
  }));
  const labelIndex = new Map(opts.slots.map((label, i) => [label, i]));

  let frameIdx = 0;
  let lastLineCount = 0;
  let finished = false;

  function buildFrame(): string {
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length]!;
    const allSettled = states.every((s) => s.settled);
    const anyFailed = states.some((s) => s.failed);

    const lines: string[] = [];

    if (allSettled) {
      const icon = anyFailed ? red(S_ERROR) : green(S_SUCCESS);
      lines.push(`${icon}  ${opts.message}`);
    } else {
      lines.push(`${magenta(frame)}  ${opts.message}`);
    }

    for (let i = 0; i < states.length; i++) {
      const s = states[i]!;
      const isLast = i === states.length - 1;
      const connector = dim(isLast ? S_BAR_END : S_BAR);

      let icon: string;
      if (s.settled) {
        icon = s.failed ? red(S_ERROR) : green(S_SUCCESS);
      } else {
        icon = magenta(frame);
      }

      lines.push(`${connector}  ${icon} ${s.label}  ${dim(s.message)}`);
    }

    return lines.join("\n") + "\n";
  }

  function clear() {
    if (lastLineCount > 0) {
      out.write(`\x1B[${lastLineCount}A\x1B[1G\x1B[J`);
    }
    lastLineCount = 0;
  }

  function render() {
    if (!isTTY || finished) {
      return;
    }
    if (lastLineCount > 0) {
      clear();
    }
    const frame = buildFrame();
    out.write(frame);
    lastLineCount = states.length + 1;
  }

  function showCursor() {
    if (isTTY) {
      out.write("\x1B[?25h");
    }
  }

  function cleanup() {
    if (finished) {
      return;
    }
    finished = true;
    clearInterval(interval);
    if (isTTY && lastLineCount > 0) {
      clear();
    }
    showCursor();
    removeHandlers();
  }

  const onExit = () => cleanup();
  const onSignal = () => {
    cleanup();
    process.exit(128);
  };

  function installHandlers() {
    process.on("exit", onExit);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  function removeHandlers() {
    process.removeListener("exit", onExit);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  if (isTTY) {
    out.write("\x1B[?25l");
  }
  installHandlers();
  render();
  const interval = setInterval(() => {
    frameIdx++;
    render();
  }, 80);
  if (typeof interval === "object" && "unref" in interval) {
    (interval as NodeJS.Timeout).unref();
  }

  function emitNonTTY(label: string, message: string, failed: boolean) {
    if (isTTY) {
      return;
    }
    const icon = failed ? S_ERROR : S_SUCCESS;
    out.write(`${icon} ${label}  ${message}\n`);
  }

  return {
    slot(label: string): Progress {
      const idx = labelIndex.get(label);
      if (idx === undefined) {
        return createSilentProgress();
      }
      const state = states[idx]!;

      return {
        update(message: string) {
          if (state.settled) {
            return;
          }
          state.message = message;
        },
        warn(warnLabel: string, detail?: string) {
          if (state.settled) {
            return;
          }
          state.message = detail ? `${warnLabel}: ${detail}` : warnLabel;
        },
        fail(failLabel: string, detail?: string) {
          if (state.settled) {
            return;
          }
          state.message = detail ? `${failLabel}: ${detail}` : failLabel;
          state.failed = true;
          state.settled = true;
          emitNonTTY(state.label, state.message, true);
        },
        hasFailed: () => state.failed,
        done(summary: string) {
          if (state.settled) {
            return;
          }
          state.message = summary;
          state.settled = true;
          emitNonTTY(state.label, state.message, false);
        },
        ensureSettled() {
          if (state.settled) {
            return;
          }
          state.settled = true;
          emitNonTTY(state.label, state.message, state.failed);
        },
      };
    },

    done() {
      if (finished) {
        return;
      }
      for (const s of states) {
        if (!s.settled) {
          s.settled = true;
        }
      }
      finished = true;
      clearInterval(interval);
      removeHandlers();

      if (isTTY) {
        if (lastLineCount > 0) {
          clear();
        }
        frameIdx = 0;
        const frame = buildFrame();
        out.write(frame);
        showCursor();
      } else {
        const anyFailed = states.some((s) => s.failed);
        const icon = anyFailed ? S_ERROR : S_SUCCESS;
        out.write(`${icon}  ${opts.message}\n`);
      }
    },
  };
}
