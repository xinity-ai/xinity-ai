/**
 * Remote probe: collects all state the doctor needs in a single SSH call.
 *
 * Builds a shell script dynamically, runs it once via `host.runShell()`,
 * and parses a simple line-based output format. Reduces 50+ SSH
 * round-trips to 1-2.
 */
import { COMMAND_FALLBACK_BIN_DIRS, type Host, type RunResult } from "./host.ts";
import type { Manifest } from "./manifest.ts";
import { unitName } from "./systemd.ts";
import { type Component, ENV_DIR, SECRETS_DIR, ENV_SCHEMAS, BIN_DIR, UNIT_DIR } from "./component-meta.ts";
import { analyzeEnvSchema, categorizeFields } from "./env-prompt.ts";

export interface RemoteState {
  platform: string;
  files: Record<string, boolean>;
  /** Base64-encoded file contents (null if missing/unreadable) */
  fileContents: Record<string, string | null>;
  commands: Record<string, boolean>;
  units: Record<string, string>;
}

const SEPARATOR = "::XPROBE::";

/**
 * Collect all needed state from a remote host in a single SSH call.
 */
export async function collectRemoteState(
  host: Host,
  manifest: Manifest,
): Promise<RemoteState> {
  const filesToCheck: string[] = [];
  const filesToRead: string[] = [];
  // TODO drop unzip on v1.0.0
  const commandsToCheck: string[] = ["systemctl", "weed", "ollama", "docker", "nvidia-smi", "tar", "unzip", "curl"];
  const unitsToCheck: string[] = ["xinity-ai-seaweedfs.service", "ollama.service", "ollama"];

  // SeaweedFS paths
  filesToCheck.push(`${BIN_DIR}/weed`);
  filesToCheck.push(`${UNIT_DIR}/xinity-ai-seaweedfs.service`);

  // Per component
  const components: Component[] = ["gateway", "dashboard", "daemon", "infoserver"];
  for (const comp of components) {
    const entry = manifest.components[comp];
    if (!entry) continue;

    filesToCheck.push(entry.binaryPath);
    filesToCheck.push(`${UNIT_DIR}/${unitName(comp)}`);
    unitsToCheck.push(unitName(comp));

    const envPath = `${ENV_DIR}/${comp}.env`;
    filesToCheck.push(envPath);
    filesToRead.push(envPath);

    const schema = ENV_SCHEMAS[comp];
    const fields = analyzeEnvSchema(schema);
    const { secretFields } = categorizeFields(fields);
    for (const field of secretFields) {
      filesToRead.push(`${SECRETS_DIR}/${field.key}`);
    }
  }

  const script = buildProbeScript(filesToCheck, filesToRead, commandsToCheck, unitsToCheck);
  const result = await host.runShell(script);

  const state: RemoteState = {
    platform: "unknown",
    files: {},
    fileContents: {},
    commands: {},
    units: {},
  };

  if (!result.ok && !result.output) return state;

  // Parse line-based output: TYPE::KEY::VALUE
  for (const line of result.output.split("\n")) {
    const [type, key, ...rest] = line.split(SEPARATOR);
    if (type == null || key == null || rest.length === 0) continue;
    const value = rest.join(SEPARATOR); // rejoin in case value contained separator

    switch (type) {
      case "P": state.platform = value; break;
      case "F": state.files[key] = value === "1"; break;
      case "R": state.fileContents[key] = value === "NULL" ? null : value; break;
      case "C": state.commands[key] = value === "1"; break;
      case "U": state.units[key] = value; break;
    }
  }

  return state;
}

function buildProbeScript(
  filesToCheck: string[],
  filesToRead: string[],
  commands: string[],
  units: string[],
): string {
  const S = SEPARATOR;
  const lines: string[] = [];

  // Platform
  lines.push(`printf 'P${S}os${S}%s\\n' "$(uname -s)"`);

  // File existence
  for (const f of filesToCheck) {
    lines.push(`[ -e '${f}' ] && echo 'F${S}${f}${S}1' || echo 'F${S}${f}${S}0'`);
  }

  // File contents (base64 encoded, single-line)
  for (const f of filesToRead) {
    lines.push(`if [ -r '${f}' ]; then printf 'R${S}${f}${S}'; base64 < '${f}' | tr -d '\\n'; echo; else echo 'R${S}${f}${S}NULL'; fi`);
  }

  // Command existence
  for (const c of commands) {
    const fallback = COMMAND_FALLBACK_BIN_DIRS.map((dir) => `[ -x "${dir}/${c}" ]`).join(" || ");
    lines.push(`(command -v '${c}' >/dev/null 2>&1 || ${fallback}) && echo 'C${S}${c}${S}1' || echo 'C${S}${c}${S}0'`);
  }

  // Unit status
  for (const u of units) {
    lines.push(`printf 'U${S}${u}${S}%s\\n' "$(systemctl is-active '${u}' 2>/dev/null || echo unknown)"`);
  }

  return lines.join("\n");
}

/**
 * Create a host wrapper that uses pre-collected remote state
 * for file/command/service checks, falling back to the real host
 * only for operations not covered by the probe (like tunneling).
 */
export function createCachedHost(realHost: Host, state: RemoteState): Host {
  return {
    isRemote: realHost.isRemote,

    run(args: string[]): Promise<RunResult> {
      // Intercept `systemctl is-active <unit>` and `uname -s`
      if (args[0] === "systemctl" && args[1] === "is-active" && args[2]) {
        const status = state.units[args[2]];
        if (status !== undefined) {
          const ok = status === "active";
          return Promise.resolve({ ok, output: status, exitCode: ok ? 0 : 3 });
        }
      }
      if (args[0] === "uname" && args[1] === "-s") {
        return Promise.resolve({ ok: true, output: state.platform, exitCode: 0 });
      }
      // Intercept `which <name>` or `test -e`
      if (args[0] === "which" && args[1]) {
        const found = state.commands[args[1]] ?? false;
        return Promise.resolve({ ok: found, output: found ? args[1] : "", exitCode: found ? 0 : 1 });
      }
      if (args[0] === "test" && args[1] === "-e" && args[2]) {
        const exists = state.files[args[2]] ?? false;
        return Promise.resolve({ ok: exists, output: "", exitCode: exists ? 0 : 1 });
      }
      return realHost.run(args);
    },

    runShell(command: string): Promise<RunResult> {
      // Intercept commandExistsOn pattern: `command -v <name> || test -x ...`
      const [, name] = command.match(/^command -v (\S+)/) ?? [];
      if (name) {
        const found = state.commands[name] ?? false;
        return Promise.resolve({ ok: found, output: found ? name : "", exitCode: found ? 0 : 1 });
      }
      return realHost.runShell(command);
    },

    async readFile(path: string): Promise<string | null> {
      if (path in state.fileContents) {
        const val = state.fileContents[path];
        if (val == null) return null;
        return Buffer.from(val, "base64").toString("utf-8");
      }
      return realHost.readFile(path);
    },

    async fileExists(path: string): Promise<boolean> {
      if (path in state.files) return state.files[path]!;
      return realHost.fileExists(path);
    },

    withElevation: realHost.withElevation.bind(realHost),
    uploadFile: realHost.uploadFile.bind(realHost),
    downloadFile: realHost.downloadFile.bind(realHost),
    verifySha256: realHost.verifySha256.bind(realHost),
    computeSha256: realHost.computeSha256.bind(realHost),
    getArch: realHost.getArch.bind(realHost),
    openTunnel: realHost.openTunnel.bind(realHost),
    dispose: realHost.dispose.bind(realHost),
  };
}
