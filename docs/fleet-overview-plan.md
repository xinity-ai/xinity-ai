# Fleet Overview Page — Integration Plan

## Goal

A new dashboard page that shows the customer **their compute fleet at a glance**:
which machines are connected (e.g. 3× Asus Ascent GX10, 2× RTX 6000 Pro, 1× H100),
whether they are healthy, how utilized they are, how much energy they consumed,
which models they host, how many tokens they processed, and how many requests
succeeded vs. failed.

**Design principle: reassurance over accounting.** The page exists to make the
customer feel that their compute is alive, healthy, and generating value. All
numbers may be approximate. This drives every trade-off below: coarse sampling,
in-place aggregates, estimation fallbacks — never heavyweight observability
infrastructure (no Prometheus storage, no time-series DB).

## What we already have vs. what is missing

| Dimension | Status | Source |
|---|---|---|
| Machine inventory (GPUs, VRAM, drivers) | ✅ exists | `ai_node.gpus`, `.gpuCount`, `.driverVersions` (daemon registers at startup) |
| Machine product name ("Asus Ascent GX10") | ❌ missing | add DMI read (`/sys/class/dmi/id/product_name`) to daemon hardware detect |
| Installed models per machine | ✅ exists | `model_installation` ⋈ `ai_node` (+ lifecycle state) |
| GPU utilization / power / memory (runtime) | ❌ missing | daemon must sample `nvidia-smi` / `rocm-smi` periodically |
| Energy consumed | ❌ missing | integrate sampled power over time; fallback: utilization × TDP estimate |
| Tokens per machine | ⚠️ partial | `usage_event` has tokens but **no nodeId** — gateway knows the selected node but doesn't record it |
| Request success/failure | ❌ missing | gateway counts statuses in in-memory Prometheus metrics only; nothing persisted |
| Liveness ("last seen") | ⚠️ partial | `ai_node.available` set at startup only; no heartbeat |

## Architecture decisions

1. **Daemon writes metrics directly to Postgres** — consistent with how it
   already upserts `ai_node` (`statekeeper.ts`). No new transport, no new service.
2. **Coarse, pre-aggregated time series.** Daemon samples GPUs every ~20 s
   in memory, flushes **one row per node per 5 minutes** to a new `node_metric`
   table (avg/max utilization, avg watts, Wh delta, memory used). At 6 nodes
   that is ~1,700 rows/day — negligible. Retention pruned to 90 days; lifetime
   totals (energy, tokens) kept as monotonic counters on the node so "all-time"
   stats survive pruning.
3. **Token/request attribution via one new column.** The gateway already holds
   the selected node when it records a `usage_event`; we add `nodeId` and
   `success` columns and pass them through. This is cheaper and more honest
   than proportional approximation, and failure rows give us success-rate for free.
4. **Energy is an estimate and labeled as such.** `Wh = avg(power.draw) × Δt`.
   Where power isn't readable (some iGPU/Jetson-class devices), estimate from
   `utilization × TDP` using a small lookup of known GPUs, marked "≈" in the UI.
5. **Heartbeat piggybacks on the metrics flush** — `ai_node.lastSeenAt`
   updated on every flush; UI treats >2 missed intervals as offline.
6. **Live feel without websockets.** The page polls its oRPC procedure every
   ~12 s (matches existing SSE/poll-only patterns) and animates value
   transitions. Sparklines + pulsing status dots create the "alive" feeling.
7. **Permissions** mirror `cluster.procedure.ts`: guarded with
   `requirePermission({ modelDeployment: ["read"] })` behind `withOrganization`.
   Hardware/fleet data is instance-wide; token aggregates shown on this page are
   fleet totals (not broken down per org), so no cross-org data leak.

## UI / UX concept

Route: `/(authenticated)/fleet` ("Compute" in the sidebar, CPU/server icon).

```
┌──────────────────────────────────────────────────────────────────┐
│  Fleet            ● 6 machines online        ⚡ 1.2 kWh today     │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐                 │
│  │ 12 GPUs │ │ 38% util│ │ 4.2M tok│ │ 99.4% ✓ │   ← hero tiles  │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘                 │
│                                                                  │
│  ▁▂▃▅▆▅▃▂▁  Fleet activity (tokens/min, stacked per machine)    │
│                                                                  │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐        │
│  │ ● ascent-01    │ │ ● rtx6000-01   │ │ ● h100-01      │        │
│  │ Asus Ascent    │ │ RTX 6000 Pro   │ │ H100 80GB      │        │
│  │ GX10           │ │                │ │                │        │
│  │ ◔ 42% util     │ │ ◔ 71% util     │ │ ◔ 18% util     │        │
│  │ ▁▃▅▃▂ sparkline│ │ ▂▄▆▅▃          │ │ ▁▁▂▁▁          │        │
│  │ ⚡ ≈210 Wh     │ │ ⚡ ≈480 Wh     │ │ ⚡ ≈350 Wh      │        │
│  │ ⇄ 1.1M in /    │ │ ⇄ 2.3M in /    │ │ ⇄ 0.4M in /    │        │
│  │   380k out     │ │   870k out     │ │   95k out      │        │
│  │ ✓ 99.7% of 8k  │ │ ✓ 99.1% of 14k │ │ ✓ 100% of 2k   │        │
│  │ [llama3] [qwen]│ │ [mixtral]      │ │ [llama3-70b]   │        │
│  └────────────────┘ └────────────────┘ └────────────────┘        │
└──────────────────────────────────────────────────────────────────┘
```

Style: existing card components (`$lib/components/ui/card`), Chart.js via the
existing `Chart.svelte` wrapper, OKLCH chart tokens `--chart-1..5`, xinity
purple→coral gradient reserved for the utilization rings and the hero strip
accent. Status dots pulse softly (CSS animation) when a machine reported within
the last interval. Numbers tween on poll updates. Offline machines render
dimmed with "last seen X min ago" — visible but clearly resting, never alarming
unless truly gone.

Empty/degraded states matter for the reassurance goal: a machine with no
metrics yet shows its inventory + "warming up…" shimmer instead of zeros.

## Phases

Each phase is independently shippable and tested; we review together between phases.

### Phase 1 — Data foundation (`common-db`)
- New `node_metric` table: `nodeId, bucketStart, gpuUtilizationAvg, gpuUtilizationMax, memoryUsedMb, powerWattsAvg, energyWh` (+ index `(nodeId, bucketStart)`).
- `ai_node`: add `machineName` (DMI product), `lastSeenAt`, lifetime counters `totalEnergyWh`.
- `usage_event`: add nullable `nodeId`, `success` (default true so existing rows stay valid); extend `usage_summary` rollup columns (`failedCalls`, per-node key) only if needed after we see query shapes.
- Drizzle schema + migration.
- **Tests:** migration applies cleanly; schema typecheck; insert/select round-trip.

### Phase 2 — Daemon telemetry (`xinity-ai-daemon`)
- `metrics-sampler` module: poll `nvidia-smi --query-gpu=utilization.gpu,power.draw,memory.used` (rocm-smi equivalent) every ~20 s; in-memory aggregation; flush one `node_metric` row + `lastSeenAt` + lifetime counters every 5 min; prune rows >90 days opportunistically.
- TDP-estimate fallback when `power.draw` is `[N/A]`.
- DMI product-name detection added to hardware detect → `machineName`.
- Honor existing shutdown handling (flush partial bucket on SIGTERM).
- **Tests:** unit tests for smi output parsing (real captured outputs incl. `[N/A]`), aggregation math, energy integration, fallback path.

### Phase 3 — Gateway attribution (`xinity-ai-gateway`)
- Thread selected node through to `usageRecorder` → write `nodeId`.
- Record failed requests too (currently only successes produce rows) with `success=false`; keep it best-effort and non-blocking on the hot path.
- **Tests:** usageRecorder unit tests for success/failure/node attribution; verify existing gateway tests stay green.

### Phase 4 — Dashboard API (`xinity-ai-dashboard`)
- `fleet.procedure.ts` (follow `add-dashboard-orpc-procedure` skill / cluster.procedure guard pattern):
  - `fleet.overview` — nodes with inventory, latest metrics, liveness, installed models (+ lifecycle), per-node token/request/energy aggregates for a time range.
  - `fleet.history` — bucketed time series (utilization, tokens/min per node) for the activity chart and sparklines.
- Seed script for local dev (fake nodes + metrics) so UI work doesn't require real GPUs.
- **Tests:** e2e API tests (shape, RBAC: viewer can read, unauthenticated 401), empty-fleet response.

### Phase 5 — UI (`xinity-ai-dashboard`)
- Route `/(authenticated)/fleet` + sidebar entry, `+page.server.ts` initial load + client polling (~12 s).
- Components: `FleetHero` (stat tiles), `MachineCard` (status dot, utilization ring, sparkline, energy, tokens, success rate, model badges), `FleetActivityChart` (stacked Chart.js), number-tween util.
- Empty, warming-up, and offline states.
- **Tests:** Playwright — page renders against seeded data, sidebar navigation, offline-node rendering; component unit tests for formatting helpers (Wh/kWh, token abbreviations).

### Phase 6 — Polish & production hardening
- Full `run-tests` sweep across packages; perf sanity on the overview query (indexes hit, single round trip).
- Visual pass: dark/light themes, mobile breakpoints, reduced-motion respect for pulse/tween animations.
- Docs touch-up (`architecture.md` note on node telemetry), CHANGELOG entry, screenshots → PR.

## Approximation tolerances (as built)

| Dashboard value | Deviation from exact | Dominant error source |
|---|---|---|
| Machine load % | ±3–5 pts steady, up to ±10 pts bursty; ≤ ~5 min stale | `utilization.gpu` is a "kernel active" flag sampled every 20 s, bucketed per 5 min |
| Fleet load | Same, plus weighting skew | Unweighted mean — a small GPU counts like an H100 |
| Energy (measured) | ±5–10% of **GPU** energy; excludes CPU/PSU (~30–50% of wall draw) | NVML sensor ±5%, 20 s integration |
| Energy (TDP fallback) | ±30–50% | Linear `TDP × (10% + 90%·util)` model, TDP table ambiguity |
| Tokens | Effectively exact | Backend tokenizer counts; failures record 0 tokens |
| Requests / success | Exact counts; definitional choices | Client aborts excluded, post-selection 400s count as failures |
| Online/offline | Lags reality by up to 15 min | Heartbeat window = 3 missed 5-minute flushes |

The two roughest values (energy) are the ones labeled "≈" in the UI; the values a
customer could cross-check against their own logs (tokens, requests) are exact.

## Out of scope (deliberately)
- Exact billing-grade accounting, per-GPU drill-down pages, alerting/notifications,
  temperature/fan telemetry, historical retention beyond 90 days. All can layer on
  later without schema changes beyond what Phase 1 adds.
