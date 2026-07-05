# Daemon

The daemon runs on each GPU node in the cluster. It manages model installation, reports hardware state, and exposes a local proxy that the gateway routes requests through.

For configuration, development setup, and the run-model script, see the [daemon README](../../packages/xinity-ai-daemon/README.md). For deployment, see the [CLI deployment guide](../../deployment/cli/README.md) or the [NixOS deployment guide](../../deployment/nixos/README.md).

## GPU Auto-Detection

On startup, the daemon detects available GPU hardware:

| Vendor | Detection method |
|---|---|
| **NVIDIA** | `nvidia-smi` (GPU name, VRAM per card) |
| **AMD** | Sysfs (`/sys/class/drm`), fallback to `rocm-smi` |
| **Intel** | `xpu-smi discovery` |

Unified memory systems (e.g., DGX Spark) are detected when GPUs report zero VRAM, allocating 90% of system RAM as usable capacity. When no GPUs are found at all, system RAM is used as the capacity figure for CPU-only inference.

The detected hardware profile is registered in the database and visible on the [dashboard's Compute page](dashboard.md#compute-dashboard).

## Model Installation

The daemon receives deployment instructions from the dashboard via the shared database. A sync loop runs periodically (default: every 5 minutes) and triggers immediately via PostgreSQL `LISTEN/NOTIFY` when the dashboard creates or modifies a deployment.

### Ollama

Models are pulled from the Ollama registry with progress tracking (debounced to 15-second updates). Up to 2 concurrent pull/delete operations.

### vLLM

The installation flow: download weights from HuggingFace (resumable, with file filtering), start the server, poll health (default timeout: 1 hour), then run a warmup request. GPU memory utilization is computed automatically with overhead, capped at 90%.

**Two backends** are available:

| Backend | How it works |
|---|---|
| `systemd` (default) | Manages `vllm-driver@{id}.service` template units. |
| `docker` | Runs in containers with `--gpus all` on an egress-blocked network. Selected automatically when `VLLM_DOCKER_IMAGE` is set. |

The Docker backend blocks all outbound internet from the inference process (IP masquerade disabled, `HF_HUB_OFFLINE=1`). Models are pre-downloaded by the daemon outside the container.

Failed processes are restarted up to 3 times (configurable). Fatal log patterns (GPU OOM, CUDA errors, etc.) trigger immediate failure without retries.

## Cache Eviction

Before downloading a new model, the daemon checks disk space and evicts orphaned model caches oldest-first. Caches with active installations or belonging to the model being downloaded are never evicted.

## GPU Metrics

For NVIDIA GPUs, the daemon samples telemetry every 20 seconds (configurable): compute utilization, memory utilization, temperature, power draw (measured or estimated from TDP curves), cumulative energy consumption, ECC errors, and throttling state. AMD and Intel telemetry is not yet implemented.

These metrics power the [Compute dashboard](dashboard.md#compute-dashboard) and are exposed via [Prometheus](monitoring.md).

## Node State

The daemon registers itself in the database with capacity, GPU details, supported drivers and versions, hostname, and port. The `CIDR_PREFIX` setting controls which network interface is advertised in multi-homed setups. On shutdown, the daemon marks itself as offline.

## Run-Model Script

A standalone script for testing models locally without a full cluster. Supports `--plan` (dry run), `--start`, `--download`, and `--stop`. See the [daemon README](../../packages/xinity-ai-daemon/README.md#run-model-script) for usage.
