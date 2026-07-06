import type { SpinnerResult } from "@clack/prompts";
import * as p from "./clack.ts";
import { pass, fail, warn, info } from "./output.ts";
import type { StepEvent } from "./step-event.ts";

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
        const s = p.spinner();
        s.start(event.message ?? "");
        spinners.set(event.id, s);
      }
      break;
    }
    case "log": {
      p.log.info(event.message);
      break;
    }
  }
}

export async function runSteps<T>(gen: AsyncGenerator<StepEvent, T>): Promise<T> {
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

export async function collectSteps<T>(gen: AsyncGenerator<StepEvent, T>): Promise<{ events: StepEvent[]; result: T }> {
  const events: StepEvent[] = [];
  let result = await gen.next();
  while (!result.done) {
    events.push(result.value);
    result = await gen.next();
  }
  return { events, result: result.value };
}
