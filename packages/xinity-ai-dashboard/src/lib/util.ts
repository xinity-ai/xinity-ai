/**
 * General-purpose helpers shared across the dashboard app.
 * Several functions mirror small lodash utilities for consistency.
 */

import type { SafeResult } from "@orpc/client";

/** Lowercase a name and collapse runs of non-alphanumeric chars into single dashes. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Returns the trimmed string, or undefined when the result is empty. */
export function trimOrUndefined(value: string): string | undefined {
  return value.trim() || undefined;
}

/** Omits the specified keys from an object. */
export function omit<T extends object, P extends (keyof T)[]>(
  object: T,
  ...keys: P
): Omit<T, P[number]> {
  return Object.fromEntries(
    Object.entries(object).filter((v) => !keys.includes(v[0] as keyof T)),
  ) as Omit<T, P[number]>;
}

/** Picks the specified keys from an object. */
export function pick<T extends object, P extends (keyof T)[]>(
  object: T,
  ...keys: P
): Pick<T, P[number]> {
  return Object.fromEntries(
    Object.entries(object).filter((v) => keys.includes(v[0] as keyof T)),
  ) as Pick<T, P[number]>;
}

/** Pauses execution for the provided number of milliseconds. */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Performs an optimistic update and rolls back when the API call fails. */
export async function updateOptimistically<E>({
  apiPromise,
  update,
  undo,
}: {
  /** function that produces the promise that will be awaited */
  apiPromise: () => Promise<SafeResult<any, E>>;
  /** preemtive synchronous update to simulate the api calls effect locally */
  update: () => void;
  /** undo function, to undo the local effect previously set up by the update, in case of an error */
  undo: (error: E) => void;
}) {
  update();
  const { error, data } = await apiPromise();
  if (error) {
    undo(error);
  }
  return data;
}

/** Formats a GB value, trimming insignificant decimal places (e.g. 8.333... -> "8.33 GB", 230 -> "230 GB"). */
export function formatGb(value: number): string {
  return `${parseFloat(value.toFixed(2))} GB`;
}

export function humanDate(d: Date | string | undefined) {
  if (!d) return "Unknown date";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function humanDateShort(d: Date | undefined) {
  if (!d || !d.toLocaleDateString) return "Unknown date";
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** Month precision, since the day a model was released is noise when comparing models. */
export function humanMonthYear(isoDate: string) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatDurationMs(ms: number | null): string {
  if (ms == null) return "-";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Formats a duration expressed in hours into a human-readable label. */
export function humanDuration(hours: number) {
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const days = Math.floor(totalMinutes / (60 * 24));
  const remainingHours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const remainingMinutes = totalMinutes % 60;

  const segments = [
    days > 0 && `${days}d`,
    remainingHours > 0 && `${remainingHours}h`,
    remainingMinutes > 0 && `${remainingMinutes}m`,
  ].filter(Boolean);
  return segments.join(" ");
}

/** Creates a function, that caches a generated value for the indicated milliseconds for future calls */
export function timeCache<T>(ms: number, getter: () => Promise<T>): () => Promise<T> {
  let cachedValue: T;
  let cachedAt = -Infinity;

  const isCacheFresh = () => Date.now() - cachedAt < ms;

  return async () => {
    if (isCacheFresh()) {
      return cachedValue;
    }
    cachedValue = await getter();
    cachedAt = Date.now();
    return cachedValue;
  };
}