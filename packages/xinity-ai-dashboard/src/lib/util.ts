/**
 * General-purpose helpers shared across the dashboard app.
 * Several functions mirror small lodash utilities for consistency.
 */

import type { SafeResult } from "@orpc/client";

/** Transforms a string into a URL-safe path segment while keeping it readable. */
export function formatUrlSegment(segment: string) {
  return segment.replace(/(\s|-|\/)+/g, "_").replace(/\?|#/g, "");
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

/** Picks object entries that match a value predicate. */
export function pickWhere<T extends object, P extends T[keyof T]>(
  object: T,
  condition: (v: P) => boolean,
): Partial<T> {
  return Object.fromEntries(Object.entries(object).filter((v) => condition(v[1]))) as Partial<T>;
}

/** Safely parses a URL string and returns false when invalid. */
export function safeParseUrl(url: string): URL | false {
  if (URL.canParse(url)) {
    return new URL(url);
  }
  return false;
}

/** Returns the input value unchanged. */
export const identity = <T>(v: T) => v;

/** Computes the median value from a list of numbers. */
export function median(numbers: number[]) {
  if (numbers.length === 0) return null;
  if (numbers.length === 1) return numbers[0];
  numbers = Array.from(numbers);
  numbers.sort((a, b) => a - b);
  const mid = Math.floor(numbers.length / 2);

  if (numbers.length % 2 === 0) {
    return (numbers[mid - 1] + numbers[mid]) / 2;
  } else {
    return numbers[mid];
  }
}

/** Maps each value of an object to a new value. */
export function mapValues<T extends object, P>(
  obj: T,
  mapping: (vl: T[keyof T], k: keyof T) => P,
): Record<keyof T, P> {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [key, mapping(value, key as keyof T)]),
  ) as Record<keyof T, P>;
}

/** Pauses execution for the provided number of milliseconds. */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns a copy of a URL with the provided query parameters applied. */
export function urlWithQuery(url: URL, query: Record<string, string>) {
  const copy = new URL(url);
  for (let [key, value] of Object.entries(query)) {
    copy.searchParams.set(key, value);
  }
  return copy;
}

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

/** Formats a duration expressed in hours into a human-readable label. */
export function humanDuration(hours: number) {
  if (hours < 1) {
    return `${Math.round(hours * 60)}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = Math.floor(hours % 24);
  let result = "";
  if (days > 0) {
    result += `${days}d `;
  }
  if (remHours > 0 || days === 0) {
    result += `${remHours}h`;
  }
  return result.trim();
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