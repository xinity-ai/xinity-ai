# Xinity AI Daemon

The daemon runs on each GPU node in the cluster. It detects hardware, installs and manages models via Ollama or vLLM, reports node state to the tether (which writes it to the database), and exposes a local proxy that the gateway routes inference requests through. The daemon has no direct database connection.

## Development

```bash
bun install
bun run dev
```

If you have direnv installed, set up a `.envrc` file with `use flake .` to automatically load the devshell.

## Runtime Behavior

On startup, the daemon:

1. Detects GPU hardware (NVIDIA via `nvidia-smi`, AMD via sysfs/`rocm-smi`, Intel via `xpu-smi`). Falls back to system RAM when no GPUs are found. Unified memory systems (e.g., DGX Spark) are detected and allocated at 90% of system RAM.
2. Opens a persistent SSE connection to the tether, sending its hardware profile (capacity, GPU details, drivers, hostname, port) as the registration body. The tether upserts the node record in the database.
3. Receives desired state (model installations) from the tether over the SSE stream and installs/removes models accordingly. Changes are pushed immediately when the dashboard updates a deployment.
4. Reports installation lifecycle state back to the tether via `POST /api/v1/status`.
5. Starts GPU telemetry sampling (NVIDIA only, every `METRICS_SAMPLE_INTERVAL_MS`, default 20 seconds) for utilization, temperature, power, energy, ECC errors, and throttling.
6. Exposes Prometheus metrics at `/metrics` and an OpenAI-compatible proxy at `/proxy/*`.

On disconnect, the tether marks the node as offline in the database.

### Ollama Driver

The driver needs no configuration: the daemon probes `OLLAMA_URL` (default `http://localhost:11434`) on each sync and offers the driver whenever that endpoint answers. Set `OLLAMA_URL` only when Ollama listens elsewhere.

Models are pulled from the Ollama registry with progress tracking. Up to 2 concurrent pull/delete operations.

### vLLM Driver

Models go through: download from HuggingFace (resumable, with file filtering), start as a systemd unit or Docker container, health check polling (default timeout: 1 hour), and warmup request. GPU memory utilization is computed automatically with a 10% overhead factor, capped at 90%.

Failed processes are restarted up to `VLLM_MAX_RESTART_COUNT` times. A number of fatal log patterns (e.g. GPU OOM, CUDA errors) trigger immediate failure without retries.

**Docker backend:** Containers run on a custom network with IP masquerade disabled (`xinity-vllm-noegress-v1`), plus `HF_HUB_OFFLINE=1`. This blocks all outbound internet access from the inference process. Ports are published only on `127.0.0.1`.

### Cache Eviction

Before downloading a new model, the daemon checks disk space and evicts orphaned model caches oldest-first (with a 1 GB safety margin). Active installations and the model being downloaded are never evicted.

## Run-Model Script

Standalone model testing without a full cluster:

```bash
bun run src/scripts/run-model.ts --model <specifier> --start
bun run src/scripts/run-model.ts --model <specifier> --plan    # dry run
bun run src/scripts/run-model.ts --model <specifier> --stop
```

Key flags: `--models <file>`, `--image <ref>` (Docker), `--vllm-path <path>`, `--port <n>` (default: 8000), `--kv-cache <gb>`, `--force` (bypass compatibility gate), `--json`.

## Node Preparation

### Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Or use `xinity up infra-ollama`.

### vLLM

Set `VLLM_BACKEND` to choose the backend explicitly (`systemd`, the default, or `docker`); it is not inferred from which of `VLLM_PATH`/`VLLM_DOCKER_IMAGE` is set. Then set `VLLM_PATH` (path to binary, for the systemd backend) or `VLLM_DOCKER_IMAGE` (for the Docker backend) in the daemon's environment.

## Configuration

<!-- [sync:config] - generated from the config declaration, do not edit -->

### HTTP server

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address (use 0.0.0.0 to listen on all interfaces). |
| `PORT` | `4044` | Listen port. |
| `IDLE_TIMEOUT` | `255` | Seconds a connection may go without traffic before it is closed (Bun allows at most 255). |
| `UNIX_SOCKET` | (unset) | Unix socket path (overrides HOST/PORT when set). |

### Tether

The control plane this node reports to.

| Variable | Default | Description |
|---|---|---|
| `TETHER_URL` | (required) | URL of the xinity-tether service (e.g. http://tether:4020). |
| `TETHER_SECRET` | (required) | Shared secret authenticating daemons to the tether. Secret. |
| `SYNC_INTERVAL_MS` | `300000` | Sync interval in milliseconds. |

### This node

| Variable | Default | Description |
|---|---|---|
| `MACHINE_NAME` | (unset) | Display name for this node (defaults to hostname). |
| `CIDR_PREFIX` | `` | Network CIDR prefix (e.g. '192.168') to filter which local IP the daemon advertises. Empty = first non-internal IPv4 address. |
| `STATE_DIR` | `./.local` | Local state directory for daemon runtime data. |

### Model catalog

| Variable | Default | Description |
|---|---|---|
| `INFOSERVER_URL` | `https://sysinfo.xinity.ai` | Infoserver URL (default hosted: https://sysinfo.xinity.ai, or your self-hosted instance). |
| `INFOSERVER_CACHE_TTL_MS` | `600000` | How long the local catalog snapshot is trusted before a conditional re-fetch (ms). A refresh costs one 304 when nothing changed, so the ceiling on how stale a new entry can be is what this trades against. |

### Metrics endpoint

| Variable | Default | Description |
|---|---|---|
| `METRICS_AUTH` | (unset) | Basic auth for the /metrics endpoint (format: user:pass, comma-separated for multiple). Secret. |
| `METRICS_SAMPLE_INTERVAL_MS` | `20000` | GPU telemetry sampling interval in milliseconds. |

### vLLM

How this node runs vLLM models.

| Variable | Default | Description |
|---|---|---|
| `VLLM_BACKEND` | `systemd` | vLLM backend type. One of `systemd`, `docker`. |
| `VLLM_ENV_DIR` | `/etc/vllm` | vLLM environment config directory. |
| `VLLM_TEMPLATE_UNIT_PATH` | `/etc/systemd/system/vllm-driver@.service` | vLLM systemd template unit path. |
| `VLLM_PATH` | (unset) | Path to the vllm binary. With VLLM_BACKEND=systemd it is executed directly; with VLLM_BACKEND=docker it is the entrypoint used inside the image (default: vllm on the image PATH). Install: https://docs.vllm.ai/en/latest/getting_started/installation/index.html. |
| `VLLM_DOCKER_IMAGE` | (unset) | vLLM Docker image (enables vllm-docker driver). Options: vllm/vllm-openai (https://hub.docker.com/r/vllm/vllm-openai), timothystewart6/vllm-gb10 (https://hub.docker.com/r/timothystewart6/vllm-gb10, for DGX Spark / GB10 devices), vllm/vllm-openai:cu130-nightly (for DGX Spark / Blackwell devices). |
| `VLLM_HF_CACHE_DIR` | `/var/lib/vllm/hf-cache` | HuggingFace cache directory. |
| `VLLM_TRITON_CACHE_DIR` | `/var/lib/vllm/triton-cache` | Triton cache directory. |
| `VLLM_HF_TOKEN` | (unset) | HuggingFace token for downloading private or gated models. Secret. Can be set to `@dynamic` to take its value from the dashboard. |
| `VLLM_HEALTH_TIMEOUT_MS` | `3600000` | vLLM health check timeout in milliseconds (default: 1 hour). Can be set to `@dynamic` to take its value from the dashboard. |
| `VLLM_HEALTH_POLL_INTERVAL_MS` | `5000` | vLLM health check poll interval in milliseconds. Can be set to `@dynamic` to take its value from the dashboard. |
| `VLLM_MAX_RESTART_COUNT` | `3` | Max container restarts before marking installation as permanently failed. Can be set to `@dynamic` to take its value from the dashboard. |

### TLS

Opt-in HTTPS. See https://github.com/xinity-ai/xinity-ai/blob/main/docs/security/tls.md

Off unless all of `XINITY_TLS_CERT`, `XINITY_TLS_KEY` are set.

| Variable | Default | Description |
|---|---|---|
| `XINITY_TLS_CERT` | (required) | PEM-encoded TLS certificate. Secret. |
| `XINITY_TLS_KEY` | (required) | PEM-encoded TLS private key. Secret. |

### Logging

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `debug` | Log level. One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `LOG_DIR` | (unset) | Log file directory (enables file logging). |

### Other

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint. The ollama driver is enabled whenever this endpoint answers, so it only needs setting when ollama does not listen on its default local port. |
| `XINITY_SECRET_KEY` | (required) | 32 bytes of base64 (openssl rand -base64 32) encrypting dashboard-managed secrets at rest. The same value on every host that sets or reads one. Secret. |
| `XINITY_SECRET_KEY_PREVIOUS` | (unset) | The key XINITY_SECRET_KEY replaced, accepted for decryption only. Set during a rotation, removed once every value has been re-sealed. Secret. |

<!-- [/sync:config] -->

Every variable supports the `_FILE` suffix convention (e.g. `TETHER_SECRET_FILE`) for reading the value from a file.

## NixOS Deployment

```nix
{
  services.xinity-ai-daemon = {
    enable = true;
    environmentFiles = [ "/root/.env" ];
  };
}
```

See [`deployment/nixos/`](../../deployment/nixos/README.md) for full options.

## Testing

Testing is done largely manually via NixOS containers:

```bash
nixos-container create "xinity-ai-daemon-tester" --flake .#container
nixos-container start "xinity-ai-daemon-tester"
nixos-container root-login "xinity-ai-daemon-tester"
nixos-container stop "xinity-ai-daemon-tester"
nixos-container destroy "xinity-ai-daemon-tester"
```
