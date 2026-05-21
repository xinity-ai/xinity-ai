/**
 * Version manifest tracking installed components at /opt/xinity/manifest.json.
 */
import { type Host, createLocalHost } from "./host.ts";

export interface ComponentEntry {
  version: string;
  installedAt: string;
  binaryPath: string;
  unitName: string;
  /** SHA256 hex hash of the installed binary. Not set for dashboard (directory). */
  binaryChecksum?: string;
}

export interface Manifest {
  components: Partial<Record<string, ComponentEntry>>;
  /** Non-secret metadata about the configured DB connection. */
  db?: { hint: string };
}

const MANIFEST_PATH = "/opt/xinity/manifest.json";

async function readManifestContent(h: Host): Promise<string | null> {
  const direct = await h.readFile(MANIFEST_PATH);
  if (direct) return direct;
  // The manifest may be root-owned from an older install; retry via elevation.
  if (!(await h.fileExists(MANIFEST_PATH))) return null;
  const elevated = await h.withElevation(`cat '${MANIFEST_PATH}'`, "Read install manifest");
  return elevated.success ? elevated.output : null;
}

/**
 * Read the manifest from the given host.
 * Returns an empty manifest if the file doesn't exist.
 */
export async function readManifest(host?: Host): Promise<Manifest> {
  const empty: Manifest = { components: {} };
  const content = await readManifestContent(host ?? createLocalHost());
  if (!content) return empty;
  try {
    return JSON.parse(content) as Manifest;
  } catch {
    return empty;
  }
}

/** Get the installed version for a component, or null if not installed. */
export async function getInstalledVersion(component: string, host?: Host): Promise<string | null> {
  return (await readManifest(host)).components[component]?.version ?? null;
}

/** Write the manifest to disk (requires elevation). */
export async function writeManifest(manifest: Manifest, host?: Host): Promise<void> {
  const h = host ?? createLocalHost();
  const json = JSON.stringify(manifest, null, 2);
  const cmd = `mkdir -p /opt/xinity && cat > ${MANIFEST_PATH} << 'MANIFEST_EOF'\n${json}\nMANIFEST_EOF\nchmod 644 ${MANIFEST_PATH}`;
  await h.withElevation(cmd, "Write install manifest");
}

/** Persist a non-secret DB hint (user@host:port/dbname) into the manifest. */
export async function saveDbHint(hint: string, host?: Host): Promise<void> {
  const manifest = await readManifest(host);
  manifest.db = { hint };
  await writeManifest(manifest, host);
}

/** Update a single component entry in the manifest. */
export async function updateManifestEntry(
  component: string,
  entry: ComponentEntry,
  host?: Host,
): Promise<void> {
  const manifest = await readManifest(host);
  manifest.components[component] = entry;
  await writeManifest(manifest, host);
}
