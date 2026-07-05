# Xinity AI Daemon

The daemon runs on each GPU node in the cluster. It detects hardware, installs and manages models via Ollama or vLLM, reports node state to the database, and exposes a local proxy that the gateway routes inference requests through.

## Development

```bash
bun install
bun run dev
```

If you have direnv installed, set up a `.envrc` file with `use flake .` to automatically load the devshell.

## Runtime Behavior

On startup, the daemon:

1. Detects GPU hardware (NVIDIA via `nvidia-smi`, AMD via sysfs/`rocm-smi`, Intel via `xpu-smi`). Falls back to system RAM when no GPUs are found. Unified memory systems (e.g., DGX Spark) are detected and allocated at 90% of system RAM.
2. Registers itself in the database with capacity, GPU details, supported drivers and versions, hostname, and port.
3. Starts a sync loop (every `SYNC_INTERVAL_MS`, default 5 minutes) that reads deployment instructions from the database and installs/removes models accordingly. Also listens for PostgreSQL `NOTIFY` signals for immediate sync on dashboard changes.
4. Starts GPU telemetry sampling (NVIDIA only, every `METRICS_SAMPLE_INTERVAL_MS`, default 20 seconds) for utilization, temperature, power, energy, ECC errors, and throttling.
5. Exposes Prometheus metrics at `/metrics` and an OpenAI-compatible proxy at `/proxy/*`.

On shutdown, the daemon marks itself as offline in the database.

### Ollama Driver

Models are pulled from the Ollama registry with progress tracking. Up to 2 concurrent pull/delete operations.

### vLLM Driver

Models go through: download from HuggingFace (resumable, with file filtering), start as a systemd unit or Docker container, health check polling (default timeout: 1 hour), and warmup request. GPU memory utilization is computed automatically with a 10% overhead factor, capped at 90%.

Failed processes are restarted up to `VLLM_MAX_RESTART_COUNT` times. 14 fatal log patterns (GPU OOM, CUDA errors, unsupported architecture, etc.) trigger immediate failure.

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

Set either `VLLM_PATH` (path to binary, systemd backend) or `VLLM_DOCKER_IMAGE` (Docker backend) in the daemon's environment.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4044` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `UNIX_SOCKET` | (unset) | Unix socket path (overrides HOST/PORT) |
| `DB_CONNECTION_URL` | (required) | PostgreSQL connection string |
| `INFOSERVER_URL` | `https://sysinfo.xinity.ai` | Infoserver URL |
| `XINITY_OLLAMA_ENDPOINT` | (unset) | Ollama API endpoint (enables Ollama driver) |
| `VLLM_BACKEND` | `systemd` | `systemd` or `docker` |
| `VLLM_PATH` | (unset) | Path to vLLM binary |
| `VLLM_DOCKER_IMAGE` | (unset) | vLLM Docker image (enables Docker backend) |
| `VLLM_HF_CACHE_DIR` | `/var/lib/vllm/hf-cache` | HuggingFace model cache directory |
| `VLLM_HF_TOKEN` | (unset) | HuggingFace token for gated models |
| `VLLM_HEALTH_TIMEOUT_MS` | `3600000` (1 hour) | Health check timeout |
| `VLLM_HEALTH_POLL_INTERVAL_MS` | `5000` (5 seconds) | Health check poll interval |
| `VLLM_MAX_RESTART_COUNT` | `3` | Max restarts before marking as failed |
| `SYNC_INTERVAL_MS` | `300000` (5 minutes) | Database sync interval |
| `METRICS_SAMPLE_INTERVAL_MS` | `20000` (20 seconds) | GPU telemetry sampling interval |
| `MACHINE_NAME` | (hostname) | Display name for the node |
| `CIDR_PREFIX` | (empty) | Network CIDR prefix for IP advertisement filtering |
| `STATE_DIR` | `./.local` | Local state directory |
| `METRICS_AUTH` | (unset) | Basic auth for `/metrics` (`user:pass`) |
| `INFOSERVER_CACHE_TTL_MS` | `30000` | Infoserver response cache TTL in ms |

### TLS

| Variable | Description |
|---|---|
| `XINITY_TLS_CERT` | PEM-encoded TLS certificate |
| `XINITY_TLS_KEY` | PEM-encoded TLS private key (must be set together with cert) |

All secret variables support the `_FILE` suffix convention (e.g., `DB_CONNECTION_URL_FILE`) for reading values from files.

## NixOS Deployment

```nix
{
  services.xinity-ai-node = {
    enable = true;
    envFile = "/root/.env";
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
