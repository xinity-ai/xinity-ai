/**
 * Version manifest tracking installed components at /opt/xinity/manifest.json.
 */
import type { Host } from "../core/host.ts";
import { heredoc } from "./service.ts";

export type ComponentEntry = {
  version: string;
  installedAt: string;
  binaryPath: string;
  unitName: string;
  /** SHA256 hex hash of the installed binary. Not set for dashboard (directory). */
  binaryChecksum?: string;
}

export type StackMembership = {
  name: string;
  fleet?: string;
}

export type Manifest = {
  components: Partial<Record<string, ComponentEntry>>;
  /** Non-secret metadata about the configured DB connection. */
  db?: { hint: string };
  /** Which stack (and fleet) manages this machine; maintained by `stack up`. */
  stack?: StackMembership;
}

const MANIFEST_PATH = "/opt/xinity/manifest.json";

// One SSH read per run and host; writes invalidate so the next read
// reflects disk again (a skipped elevated write must not go unnoticed).
const manifestCache = new WeakMap<Host, Manifest>();

// Hosts whose manifest exists but could not be read or parsed. It reads as empty, and writing
// that back would erase every other entry, so writes are refused until it is repaired.
const unreadableManifests = new WeakSet<Host>();

async function readManifestContent(host: Host): Promise<string | null | "unreadable"> {
  const direct = await host.readFile(MANIFEST_PATH);
  if (direct) {
    return direct;
  }
  if (!(await host.fileExists(MANIFEST_PATH))) {
    return null;
  }
  const elevated = await host.withElevation(`cat '${MANIFEST_PATH}'`, "Read install manifest");
  return elevated.success ? elevated.output : "unreadable";
}

/**
 * Read the manifest from the given host.
 * Returns an empty manifest if the file doesn't exist.
 */
export async function readManifest(host: Host): Promise<Manifest> {
  const cached = manifestCache.get(host);
  if (cached) return structuredClone(cached);

  let manifest: Manifest = { components: {} };
  const content = await readManifestContent(host);
  if (content === "unreadable") {
    unreadableManifests.add(host);
  } else if (content) {
    try {
      manifest = JSON.parse(content) as Manifest;
    } catch {
      unreadableManifests.add(host);
    }
  }
  manifestCache.set(host, manifest);
  return structuredClone(manifest);
}

/** Write the manifest to disk (requires elevation). Refused while the existing one is unreadable. */
export async function writeManifest(manifest: Manifest, host: Host): Promise<boolean> {
  if (unreadableManifests.has(host)) {
    return false;
  }
  manifestCache.delete(host);
  const json = JSON.stringify(manifest, null, 2);
  const tmp = `${MANIFEST_PATH}.tmp`;
  const cmd = `mkdir -p /opt/xinity && { cat > ${tmp} ${heredoc("MANIFEST_EOF", json)}\n} && chmod 644 ${tmp} && mv -f ${tmp} ${MANIFEST_PATH}`;
  const result = await host.withElevation(cmd, "Write install manifest");
  return result.success;
}

/** Persist a non-secret DB hint (user@host:port/dbname) into the manifest. */
export async function saveDbHint(hint: string, host: Host): Promise<boolean> {
  const manifest = await readManifest(host);
  manifest.db = { hint };
  return writeManifest(manifest, host);
}

/** Record (or clear, with null) which stack and fleet own this host. No-op when already current. */
export async function saveStackMembership(membership: StackMembership | null, host: Host): Promise<boolean> {
  const manifest = await readManifest(host);
  if (membership === null) {
    if (!manifest.stack) {
      return true;
    }
    delete manifest.stack;
  } else {
    if (manifest.stack?.name === membership.name && manifest.stack?.fleet === membership.fleet) {
      return true;
    }
    manifest.stack = membership;
  }
  return writeManifest(manifest, host);
}

/** Update a single component entry in the manifest. */
export async function updateManifestEntry(
  component: string,
  entry: ComponentEntry,
  host: Host,
): Promise<boolean> {
  const manifest = await readManifest(host);
  manifest.components[component] = entry;
  return writeManifest(manifest, host);
}

export function manifestWriteFailure(host: Host): string {
  return unreadableManifests.has(host)
    ? `${MANIFEST_PATH} could not be read, so it was left untouched. Repair or remove it, then run again`
    : `Could not write ${MANIFEST_PATH}`;
}
