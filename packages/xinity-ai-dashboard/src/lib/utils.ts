/**
 * UI utility helpers for class name merging and component prop typing.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Creates a merged className string with Tailwind conflict resolution.
 */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Removes a `child` prop from a component props type when present.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
/**
 * Removes a `children` prop from a component props type when present.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;
/**
 * Removes both `child` and `children` from a component props type.
 */
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
/**
 * Adds a typed `ref` prop to a component props type.
 */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
