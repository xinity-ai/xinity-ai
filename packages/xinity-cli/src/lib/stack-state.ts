/**
 * Stack state: the hosts a stack actually manages, recorded as they are
 * reached. The observed counterpart to the declarative stack definition;
 * `stack up` diffs the two so hosts that were removed from the definition
 * still get torn down. Kept in its own file so observed facts never mix
 * with desired configuration.
 */
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { version as cliVersion } from "../../../../package.json";
import { xinityConfigDir, loadPrivateJson, savePrivateJson } from "./config.ts";
import type { StackDefinition } from "./stack.ts";

export interface ManagedHost {
  address: string;
}

export interface StackState {
  /** CLI version that last wrote this file; lets future versions migrate breaking changes. */
  version: string;
  hosts: ManagedHost[];
}

function statePath(name: string): string {
  return join(xinityConfigDir(), "stacks", "state", `${name}.json`);
}

export function loadStackState(name: string): StackState {
  const parsed = loadPrivateJson<Partial<StackState>>(statePath(name));
  if (!parsed) {
    return { version: cliVersion, hosts: [] };
  }
  return { version: "0.0.0", hosts: [], ...parsed };
}

function saveStackState(name: string, state: StackState): void {
  state.version = cliVersion;
  savePrivateJson(statePath(name), state);
}

export function deleteStackState(name: string): void {
  const path = statePath(name);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/** Returns true when the state changed. */
export function addManagedHost(state: StackState, address: string): boolean {
  if (state.hosts.some((h) => h.address === address)) {
    return false;
  }
  state.hosts.push({ address });
  return true;
}

/** Returns true when the state changed. */
export function removeManagedHost(state: StackState, address: string): boolean {
  const remaining = state.hosts.filter((h) => h.address !== address);
  if (remaining.length === state.hosts.length) {
    return false;
  }
  state.hosts = remaining;
  return true;
}

export function markHostManaged(name: string, address: string): void {
  const state = loadStackState(name);
  if (addManagedHost(state, address)) {
    saveStackState(name, state);
  }
}

export function unmarkHostManaged(name: string, address: string): void {
  const state = loadStackState(name);
  if (removeManagedHost(state, address)) {
    saveStackState(name, state);
  }
}

/** Managed hosts that are no longer part of the stack definition. */
export function findOrphanHosts(state: StackState, stack: StackDefinition): string[] {
  const configured = new Set(stack.hosts.map((h) => h.address));
  return state.hosts.map((h) => h.address).filter((address) => !configured.has(address));
}
