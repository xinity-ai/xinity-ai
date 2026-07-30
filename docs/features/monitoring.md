# Monitoring

The gateway, dashboard, and daemon expose Prometheus metrics (the infoserver does not). Pre-built Grafana dashboards are included for visualization. Service discovery lets Prometheus find daemon nodes automatically.

For deployment-specific monitoring setup, see the [Docker deployment guide](../../deployment/docker/README.md) or the [NixOS deployment guide](../../deployment/nixos/README.md). For the auto-generated Prometheus config in the dashboard, see [Instance Administration](instance-administration.md#monitoring-setup).

## Prometheus Metrics

Each of the gateway, dashboard, and daemon exposes a `GET /metrics` endpoint in Prometheus text format, protected by HTTP Basic Auth via the `METRICS_AUTH` environment variable (format: `user:pass`, comma-separated for multiple credentials). On the gateway and daemon this is optional; when unset, the endpoint is open. On the dashboard, `METRICS_AUTH` is required.

### Gateway metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `gateway_requests_total` | counter | `endpoint`, `status` | Total requests by endpoint and HTTP status |
| `gateway_request_errors_total` | counter | `endpoint` | Requests with status >= 400 |
| `gateway_active_requests` | gauge | `endpoint` | In-flight requests |
| `gateway_request_duration_milliseconds` | histogram | `endpoint` | Request latency |
| `gateway_time_to_first_token_milliseconds` | histogram | `deployment` | Time to first token (streaming) |
| `gateway_model_requests_total` | counter | `model`, `status`, `org_id` | Requests per model (success/failure) |
| `gateway_client_disconnects_total` | counter | `endpoint` | Client disconnections during streaming |
| `gateway_backend_errors_total` | counter | `model`, `status` | Backend errors by model and HTTP status |
| `gateway_input_tokens` | histogram | `model`, `key_id`, `org_id` | Input tokens per request |
| `gateway_output_tokens` | histogram | `model`, `key_id`, `org_id` | Output tokens per request |
| `gateway_generation_tokens_per_second` | histogram | `deployment` | Output token throughput |
| `gateway_input_tokens_total` | counter | `model`, `key_id`, `org_id` | Cumulative input tokens |
| `gateway_output_tokens_total` | counter | `model`, `key_id`, `org_id` | Cumulative output tokens |

### Dashboard metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route` | Total HTTP requests |
| (Node.js defaults) | various | | Process CPU, memory, event loop lag, heap, GC |

The dashboard uses `prom-client` and collects default Node.js/Bun runtime metrics automatically.

### Daemon metrics

All daemon metrics carry a `node_id` label, plus `machine_name` when the node has a display name set. GPU metrics additionally carry `gpu` (index) and `uuid`.

| Metric | Type | Description |
|---|---|---|
| `daemon_up` | gauge | Always 1 when the daemon is running |
| `daemon_gpu_sample_failures_total` | counter | GPU telemetry poll failures |
| `daemon_gpu_info` | gauge | GPU identity (name, driver version) |
| `daemon_gpu_utilization_percent` | gauge | Compute utilization (0-100) |
| `daemon_gpu_memory_utilization_percent` | gauge | Memory controller utilization |
| `daemon_gpu_memory_used_mb` | gauge | GPU memory in use (MiB) |
| `daemon_gpu_memory_total_mb` | gauge | Total GPU memory (MiB) |
| `daemon_gpu_temperature_celsius` | gauge | GPU temperature |
| `daemon_gpu_power_draw_watts` | gauge | Measured or estimated power draw |
| `daemon_gpu_power_limit_watts` | gauge | Power limit |
| `daemon_gpu_throttled` | gauge | 1 when throttling is active |
| `daemon_gpu_ecc_errors_total` | counter | ECC errors (labeled `type`: uncorrected or corrected) |
| `daemon_gpu_energy_wh_total` | counter | Cumulative energy since daemon start (Wh) |

## Service Discovery

The dashboard exposes `GET /metrics/sd/daemons` as an [HTTP service discovery](https://prometheus.io/docs/prometheus/latest/http_sd/) endpoint. It returns one target group per registered node (including offline ones, so Prometheus reports them as `up==0`). Each target includes:

- `__scheme__`: `https` or `http` based on the node's TLS configuration.
- `node_id`: the node's UUID.
- `machine_name`: the node's display name, only present when one is set.

This endpoint is protected by the same `METRICS_AUTH` Basic auth as `/metrics`. Prometheus should be configured to poll it every 3 minutes.

## Grafana Dashboards

Four pre-built dashboards are included. Three live in `deployment/monitoring/dashboards/` and are always provisioned; the fourth, Xinity Logs, lives in a separate `deployment/monitoring/dashboards-loki/` directory and requires Loki. Docker Compose's `monitoring` profile does not run Loki/Promtail, so it only provisions the first three. The NixOS `xinity-ai-monitoring` module provisions all four when `logs.enable = true`.

### Xinity Overview

High-level stats: gateway request rate, error rate, active requests, daemons up, GPU count, total GPU power. Dashboard service panels: HTTP request rate by route, CPU usage, resident memory, event loop lag, heap usage.

### Xinity Gateway

Traffic panels: request rate and latency by endpoint, requests by status, error rate, active requests, input/output token distributions, generation throughput. Model health panels: request rate by model, time-to-first-token, backend errors, client disconnects, failure rate. Organization usage panels: model requests by org, failure rate by org, cumulative token rate by org.

### Xinity GPU / Compute

GPU utilization, memory usage, temperature, power draw vs. limit (all as time series). GPU throttling as a state timeline.

### Xinity Logs (requires Loki, NixOS only)

Systemd journal logs for gateway, dashboard, infoserver, and daemon. Requires Loki and Promtail, provisioned only by the NixOS monitoring module (`logs.enable = true`); not available via the Docker Compose `monitoring` profile.

All dashboards are tagged `xinity-ai` and cross-linked via a shared navigation dropdown.

## Deployment

### Docker Compose

The deployment Docker Compose file includes a `monitoring` profile:

```bash
docker compose --profile monitoring up -d
```

This starts Prometheus (v3.1.0, port 9090) and Grafana (v11.4.0, port 3000) with dashboards pre-provisioned. Both bind to `127.0.0.1` by default.

Set `PROMETHEUS_URL` in the dashboard's environment to enable live GPU utilization and energy readings on the Compute page.

### NixOS

The `services.xinity-ai-monitoring` module provisions Prometheus, Grafana, and optionally Loki + Promtail:

```nix
services.xinity-ai-monitoring = {
  enable = true;
  basicAuthUsername = "prometheus";
  basicAuthPasswordFile = "/run/secrets/metrics-password";
  # Grafana is enabled by default
  logs.enable = true;  # Loki + Promtail for log aggregation
};
```

Key options:

| Option | Default | Description |
|---|---|---|
| `port` | `9090` | Prometheus port |
| `scrapeInterval` | `30s` | Global scrape interval |
| `retentionTime` | `15d` | Data retention |
| `gatewayTarget` | `localhost:4121` | Gateway metrics target |
| `dashboardTarget` | `localhost:5121` | Dashboard metrics target |
| `grafana.port` | `6121` | Grafana port |
| `logs.port` | `6122` | Loki port |
| `logs.retentionPeriod` | `168h` (7 days) | Log retention |
