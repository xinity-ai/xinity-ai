/**
 * Counting semaphore with bounded waiting. `acquire` resolves false once
 * `timeoutMs` elapses, so callers can shed load instead of queueing forever.
 */
export function createSemaphore(limit: number) {
  let active = 0;
  /** Each waiter takes the offered slot and reports whether it accepted it. */
  const waiting: Array<() => boolean> = [];

  function release(): void {
    while (waiting.length > 0) {
      if (waiting.shift()!()) {
        return;
      }
    }
    active--;
  }

  async function acquire(timeoutMs: number): Promise<boolean> {
    if (active < limit) {
      active++;
      return true;
    }
    return new Promise<boolean>(resolve => {
      let pending = true;
      const timer = setTimeout(() => {
        pending = false;
        resolve(false);
      }, timeoutMs);
      waiting.push(() => {
        if (!pending) {
          return false;
        }
        pending = false;
        clearTimeout(timer);
        resolve(true);
        return true;
      });
    });
  }

  return { acquire, release, active: () => active, waiting: () => waiting.length };
}
