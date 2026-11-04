/** How long a newly registered model keeps its "New" badge. */
const NEW_MODEL_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

/** Dates are UTC midnight while `now` is wall clock, so today can read as tomorrow. */
const CLOCK_SKEW_DAYS = 1;

export function isRecentlyAdded(registeredAt: string, now: Date = new Date()): boolean {
  const registered = Date.parse(`${registeredAt}T00:00:00Z`);
  if (Number.isNaN(registered)) {
    return false;
  }
  const ageDays = (now.getTime() - registered) / DAY_MS;
  return ageDays > -CLOCK_SKEW_DAYS && ageDays < NEW_MODEL_WINDOW_DAYS;
}
