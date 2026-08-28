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

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4044` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `UNIX_SOCKET` | (unset) | Unix socket path (overrides HOST/PORT) |
| `TETHER_URL` | (required) | URL of the xinity-tether service |
| `TETHER_SECRET` | (required) | Shared secret for tether authentication |
| `INFOSERVER_URL` | `https://sysinfo.xinity.ai` | Infoserver URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint. Only needed when Ollama listens elsewhere |
| `VLLM_BACKEND` | `systemd` | `systemd` or `docker` |
| `VLLM_PATH` | (unset) | Path to vLLM binary |
| `VLLM_DOCKER_IMAGE` | (unset) | vLLM Docker image, used when `VLLM_BACKEND=docker` |
| `VLLM_ENV_DIR` | `/etc/vllm` | vLLM environment config directory |
| `VLLM_TEMPLATE_UNIT_PATH` | `/etc/systemd/system/vllm-driver@.service` | vLLM systemd template unit path |
| `VLLM_HF_CACHE_DIR` | `/var/lib/vllm/hf-cache` | HuggingFace model cache directory |
| `VLLM_TRITON_CACHE_DIR` | `/var/lib/vllm/triton-cache` | Triton cache directory |
| `VLLM_HF_TOKEN` | (unset) | HuggingFace token for gated models |
| `VLLM_HEALTH_TIMEOUT_MS` | `3600000` (1 hour) | Health check timeout |
| `VLLM_HEALTH_POLL_INTERVAL_MS` | `5000` (5 seconds) | Health check poll interval |
| `VLLM_MAX_RESTART_COUNT` | `3` | Max restarts before marking as failed |
| `SYNC_INTERVAL_MS` | `300000` (5 minutes) | Periodic resync interval (desired state is also pushed in real time via SSE) |
| `METRICS_SAMPLE_INTERVAL_MS` | `20000` (20 seconds) | GPU telemetry sampling interval |
| `MACHINE_NAME` | (hostname) | Display name for the node |
| `CIDR_PREFIX` | (empty) | Network CIDR prefix for IP advertisement filtering |
| `STATE_DIR` | `./.local` | Local state directory |
| `METRICS_AUTH` | (unset) | Basic auth for `/metrics` (`user:pass`) |
| `INFOSERVER_CACHE_TTL_MS` | `600000` | How long the local catalog snapshot is trusted before revalidating, in ms |
| `IDLE_TIMEOUT` | `255` | Server-level idle connection timeout in seconds |
| `LOG_LEVEL` | `debug` | Log level (`fatal`/`error`/`warn`/`info`/`debug`/`trace`) |
| `LOG_DIR` | (unset) | Log file directory (enables file logging) |

### TLS

| Variable | Description |
|---|---|
| `XINITY_TLS_CERT` | PEM-encoded TLS certificate |
| `XINITY_TLS_KEY` | PEM-encoded TLS private key (must be set together with cert) |

Every environment variable above supports the `_FILE` suffix convention (e.g., `TETHER_SECRET_FILE`) for reading values from files. Secrets are just the variables where this matters most.

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
