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

/** Formats a date using the "de" locale for consistent UI display. */
export function humanDate(d: Date | undefined) {
  if (!d || !d.toLocaleDateString) return "Unknown date";
  return d.toLocaleString("de", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Formats a date (no time) using the "de" locale for consistent UI display. */
export function humanDateShort(d: Date | undefined) {
  if (!d || !d.toLocaleDateString) return "Unknown date";
  return d.toLocaleDateString("de", { dateStyle: "medium" });
}

/** Formats a duration expressed in hours into a human-readable label. */
export function humanDuration(hours: number) {
  if (hours < 1) {
    return `${Math.round(hours * 60)}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = Math.floor(hours % 24);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (remHours > 0 || days === 0) parts.push(`${remHours}h`);
  return parts.join(" ");
}

/** Creates a function, that caches a generated value for the indicated milliseconds for future calls */
export function timeCache<T>(ms: number, getter: ()=> Promise<T>): ()=> Promise<T>{
  let cache: T | null = null;
  let recency: number = Date.now();


  return async ()=> {
      const now = Date.now();
      if(cache && recency + ms > now){
        return cache;
      }

      const value = await getter();
      recency = Date.now();
      cache = value;
      return value;
  }
}