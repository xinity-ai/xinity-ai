/**
 * Version manifest tracking installed components at /opt/xinity/manifest.json.
 */
import type { Host } from "./host.ts";

export interface ComponentEntry {
  version: string;
  installedAt: string;
  binaryPath: string;
  unitName: string;
  /** SHA256 hex hash of the installed binary. Not set for dashboard (directory). */
  binaryChecksum?: string;
}

export interface StackMembership {
  name: string;
  fleet?: string;
}

export interface Manifest {
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

async function readManifestContent(host: Host): Promise<string | null> {
  const direct = await host.readFile(MANIFEST_PATH);
  if (direct) return direct;
  if (!(await host.fileExists(MANIFEST_PATH))) return null;
  const elevated = await host.withElevation(`cat '${MANIFEST_PATH}'`, "Read install manifest");
  return elevated.success ? elevated.output : null;
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
  if (content) {
    try {
      manifest = JSON.parse(content) as Manifest;
    } catch {
      // Unreadable manifest counts as empty, same as a missing file.
    }
  }
  manifestCache.set(host, manifest);
  return structuredClone(manifest);
}

/** Get the installed version for a component, or null if not installed. */
export async function getInstalledVersion(component: string, host: Host): Promise<string | null> {
  return (await readManifest(host)).components[component]?.version ?? null;
}

/** Write the manifest to disk (requires elevation). */
export async function writeManifest(manifest: Manifest, host: Host): Promise<boolean> {
  manifestCache.delete(host);
  const json = JSON.stringify(manifest, null, 2);
  const cmd = `mkdir -p /opt/xinity && cat > ${MANIFEST_PATH} << 'MANIFEST_EOF'\n${json}\nMANIFEST_EOF\nchmod 644 ${MANIFEST_PATH}`;
  const result = await host.withElevation(cmd, "Write install manifest");
  return result.success;
}

/** Persist a non-secret DB hint (user@host:port/dbname) into the manifest. */
export async function saveDbHint(hint: string, host: Host): Promise<void> {
  const manifest = await readManifest(host);
  manifest.db = { hint };
  await writeManifest(manifest, host);
}

/** Record (or clear, with null) which stack and fleet own this host. No-op when already current. */
export async function saveStackMembership(membership: StackMembership | null, host: Host): Promise<void> {
  const manifest = await readManifest(host);
  if (membership === null) {
    if (!manifest.stack) return;
    delete manifest.stack;
  } else {
    if (manifest.stack?.name === membership.name && manifest.stack?.fleet === membership.fleet) return;
    manifest.stack = membership;
  }
  await writeManifest(manifest, host);
}

/** Update a single component entry in the manifest. */
export async function updateManifestEntry(
  component: string,
  entry: ComponentEntry,
  host: Host,
): Promise<void> {
  const manifest = await readManifest(host);
  manifest.components[component] = entry;
  await writeManifest(manifest, host);
}
