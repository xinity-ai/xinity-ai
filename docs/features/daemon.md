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

The detected hardware profile is sent to the tether at registration (which writes it to the database) and visible on the [dashboard's Compute page](dashboard.md#compute-dashboard).

The daemon also detects RDMA-capable network links to other nodes, see [Node Coupling](node-coupling.md).

## Model Installation

The daemon receives deployment instructions from the tether via a persistent SSE connection. When the dashboard creates or modifies a deployment, a PostgreSQL trigger notifies the tether, which pushes the updated desired state to the daemon immediately. A periodic resync (default: every 5 minutes) acts as a safety net.

### Ollama

Models are pulled from the Ollama registry with progress tracking (debounced to 15-second updates). Up to 2 concurrent pull/delete operations.

### vLLM

The installation flow: download weights from HuggingFace (resumable, with file filtering), start the server, poll health (default timeout: 1 hour), then run a warmup request.

Each installation runs within the memory the scheduler charged it, a share of its cards and a share of host memory. The host share is a hard limit without swap, with room for the extra memory a model holds while it loads. An installation that exceeds it is stopped and reported as over its host memory budget, and one that uses more than 90% of it shows a warning in its status. Before a start, the daemon checks that the node has the memory free. If it is not free yet, for example because another installation is still loading, the installation stays installing with a status naming what it needs and what is free, and starts once that memory is free. An installation that cannot fit next to the ones already running on the node fails with that reason.

**Two backends** are available:

| Backend | How it works |
|---|---|
| `docker` (default) | Runs in containers on an egress-blocked network. Requires `VLLM_DOCKER_IMAGE`. On DGX Spark and other GB10 devices, use `timothystewart6/vllm-gb10:v0.31.0-gb10.1`. |
| `systemd` | Manages `vllm-driver@{id}.service` template units. Uses `VLLM_PATH` if set, otherwise falls back to `/usr/bin/vllm`. |

The Docker backend blocks all outbound internet from the inference process (IP masquerade disabled, `HF_HUB_OFFLINE=1`). Models are pre-downloaded by the daemon outside the container.

NVIDIA GPUs are supported. AMD and Intel GPUs are experimental and not thoroughly tested.

Failed processes are restarted up to 3 times (configurable). Fatal log patterns (GPU OOM, CUDA errors, etc.) trigger immediate failure without retries.

## Cache Eviction

Before downloading a new model, the daemon checks disk space and evicts orphaned model caches oldest-first. Caches with active installations or belonging to the model being downloaded are never evicted.

## GPU Metrics

For NVIDIA GPUs, the daemon samples telemetry every 20 seconds (configurable): compute utilization, memory utilization, temperature, power draw (measured or estimated from TDP curves), cumulative energy consumption, ECC errors, and throttling state. AMD and Intel telemetry is not yet implemented.

These metrics power the [Compute dashboard](dashboard.md#compute-dashboard) and are exposed via [Prometheus](monitoring.md).

## Node State

The daemon sends its registration (capacity, GPU details, supported drivers and versions, hostname, and port) to the tether, which upserts the node record in the database. The `CIDR_PREFIX` setting controls which network interface is advertised in multi-homed setups. On disconnect, the tether marks the node as offline.

**Warning:** the dashboard's deployment sync service treats an offline node as unavailable and, within one sync cycle (on its 5-minute timer, or immediately if triggered by another deployment change), soft-deletes any `modelInstallation` row on it for which another available node exists that could take over (matching driver, capacity, version, platform, and features). Installations with no such reassignment target are left in place. Stopping a daemon for routine maintenance can therefore orphan installations whenever capacity exists elsewhere to reassign them; patch or restart the daemon in place rather than stopping it, unless you intend for its reassignable installations to move.

## Run-Model Script

A standalone script for testing models locally without a full cluster. Supports `--plan` (dry run), `--start`, `--download`, and `--stop`. See the [daemon README](../../packages/xinity-ai-daemon/README.md#run-model-script) for usage.
