# RFC: NVIDIA Nemotron Guardrails & Multi-Attribute Reward Scorer

| Status | Implemented (v1.1) |
| :--- | :--- |
| **Authors** | Benjamin Leimer, Xinity AI Core Team |
| **Created** | 2026-08-20 |
| **Target Components** | `packages/xinity-nemotron`, `packages/xinity-ai-gateway`, `packages/common-db` |

---

## 1. Executive Summary

Enterprises deploying sovereign, on-premises AI models are strictly prohibited from using cloud-hosted safety APIs (such as OpenAI Moderation, Azure Content Safety, or Bedrock Guardrails). However, unmoderated LLMs pose critical risks including prompt injection, jailbreaking, PII leakage, and unchecked hallucinations.

This RFC defines the **Xinity Nemotron Suite** (`packages/xinity-nemotron`), an optional, pluggable enterprise module that integrates NVIDIA Nemotron foundation, guardrail, and reward models directly into the local inference pipeline with industrial-grade resilience.

### Core Capabilities
1. **Pre-Flight Prompt Guard**: On-premise prompt injection & multilingual jailbreak detection (with Unicode NFKD & diacritic normalization) before forwarding to the primary LLM.
2. **Post-Flight Output Verification**: Output safety verification before returning responses on non-streaming endpoints, and asynchronous moderation logging on SSE streams.
3. **Resilient Circuit Breaker**: Built-in 3-state circuit breaker (`closed`, `open`, `half-open`) to prevent worker outages or latency spikes from cascading to clients.
4. **Multi-Attribute Reward Scoring**: Asynchronous scoring across five core dimensions (*Helpfulness, Correctness, Coherence, Complexity, Safety*) with honest fail-safe semantics (no artificial pseudo-scores).
5. **Observability & Metrics**: Full Prometheus integration (`gateway_nemotron_*`) tracking inspection counts, latencies, reward distributions, and fail-open skips.
6. **Data Flywheel & Distillation Hook**: Automatically curating high-reward interactions ($\ge \text{threshold}$) into clean datasets for on-premise model fine-tuning and distillation.
7. **Zero Overhead by Default**: When disabled (`XINITY_NEMOTRON_ENABLED=false`), the gateway bypasses inspection completely with zero latency impact.

---

## 2. Architecture & Request Flow

```
+-----------------------------------------------------------------------------------+
|                              xinity-ai-gateway                                    |
|                                                                                   |
|  [Client Request]                                                                 |
|         |                                                                         |
|         v                                                                         |
|  +--------------------+       Enabled?       +---------------------------------+  |
|  | withEndpointGuards | -------------------> | Nemotron Guard (Pre-Flight)     |  |
|  +--------------------+         No           | - Unicode NFKD + Zero-Width     |  |
|         |                        |           | - Multilingual Regex (DE/FR/ES) |  |
|         |                        |           | - Circuit-Breaker Protected     |  |
|         |                        |           +---------------------------------+  |
|         |                        |                           |                    |
|         v                        v                           v (Verdict: ALLOW)   |
|  +-----------------------------------------------------------------------------+  |
|  |                            Inference Engine                                 |  |
|  |                        (vLLM / Ollama Node Pool)                            |  |
|  +-----------------------------------------------------------------------------+  |
|         |                                                                         |
|         +------------------------------------+                                    |
|         v (Non-Stream: Block if Unsafe)      v (Async Copy)                       |
|  +-----------------------------+     +-----------------------------------------+  |
|  | Nemotron Guard (Post-Flight)|     | Nemotron Reward Scorer (Asynchronous)   |  |
|  | - Output Safety Filter      |     | - Helpfulness: 0.0 - 1.0                |  |
|  | - Prometheus Telemetry      |     | - Correctness: 0.0 - 1.0                |  |
|  +-----------------------------+     | - Coherence:   0.0 - 1.0                |  |
|         |                            | - Complexity:  0.0 - 1.0                |  |
|         v                            | - Safety:      0.0 - 1.0                |  |
|  [Client Response]                   +-----------------------------------------+  |
|                                                          |                        |
|                                                          v (Score >= Threshold)   |
|                                              +------------------------+           |
|                                              | Distillation Dataset   |           |
|                                              | & Prometheus Metrics   |           |
|                                              +------------------------+           |
+-----------------------------------------------------------------------------------+
```

---

## 3. Detailed Component Specifications

### 3.1 Pre-Flight & Post-Flight Guardrails (`NemotronGuardEngine`)

The Guardrail engine inspects messages using lightweight, high-throughput models (such as `nvidia/nemotron-mini-4b-instruct` or dedicated Nemotron Guard checkpoints):

* **Pre-Flight**: Evaluates input `messages`. Normalizes text (NFKD Unicode decomposition, combining diacritics removal, zero-width space stripping) against known adversarial vectors, then queries the remote guard service. If a prompt violates safety policies:
  ```json
  {
    "error": {
      "message": "Prompt rejected by enterprise safety policy: adversarial jailbreak pattern detected",
      "type": "guardrail_violation",
      "code": "nemotron_preflight_block"
    }
  }
  ```
* **Post-Flight**: Evaluates generated text. Blocks unsafe non-streaming responses with a 400 error; records metrics and logs warnings for streaming responses.
* **Circuit Breaker**: Automatically trips after 5 consecutive failures, bypassing remote calls for 30s to preserve inference latency. Skips are recorded under `gateway_nemotron_guard_skip_total`.

### 3.2 Multi-Attribute Reward Evaluator (`NemotronRewardEngine`)

Post-generation, the dialogue pair is evaluated asynchronously:
* **Metrics**:
  * `helpfulness` (0.0 to 1.0)
  * `correctness` (0.0 to 1.0)
  * `coherence` (0.0 to 1.0)
  * `complexity` (0.0 to 1.0)
  * `safety` (0.0 to 1.0)
* **Composite Score**: Weighted aggregate: $0.30 \cdot H + 0.35 \cdot C + 0.15 \cdot Coh + 0.10 \cdot Cmpl + 0.10 \cdot S$.
* **Fail-Safe Integrity**: When the remote model is unreachable, returns `null` rather than generating noisy heuristic scores that pollute training pipelines.

### 3.3 Prometheus Metrics

The gateway exposes full Prometheus metrics under `/metrics`:
* `gateway_nemotron_preflight_total{verdict, category}`
* `gateway_nemotron_preflight_duration_milliseconds` (Histogram)
* `gateway_nemotron_postflight_total{verdict, category}`
* `gateway_nemotron_reward_score` (Histogram)
* `gateway_nemotron_guard_skip_total{check, reason}` (Fail-open tracking)
* `gateway_nemotron_distillation_eligible_total{model}`

---

## 4. Configuration Schema

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `XINITY_NEMOTRON_ENABLED` | `boolean` | `false` | Master toggle for the Nemotron module. |
| `XINITY_NEMOTRON_ENDPOINT` | `string` | `""` | Base URL of the Nemotron inference worker (e.g. `http://ai-node-1:8000/v1`). |
| `XINITY_NEMOTRON_API_KEY` | `string` | `""` | Optional auth token for the internal Nemotron worker. |
| `XINITY_NEMOTRON_GUARD_MODEL` | `string` | `"nemotron-mini-4b"` | Model specifier used for guardrail moderation. |
| `XINITY_NEMOTRON_REWARD_MODEL` | `string` | `"nemotron-3-reward"` | Model specifier used for multi-attribute reward scoring. |
| `XINITY_NEMOTRON_GUARD_STRICTNESS` | `enum` | `"medium"` | Strictness level: `low`, `medium`, `high`. |
| `XINITY_NEMOTRON_DISTILLATION_THRESHOLD` | `number` | `0.90` | Minimum composite score for automatic distillation export. |

---

## 5. Security, Reliability & Compliance

* **Air-Gap Compliance**: All inspections occur strictly within the sovereign VPC / on-premises network.
* **Fail-Open with Full Visibility**: If Nemotron worker fails, inference continues uninterrupted, while Prometheus metrics and structured JSON logs flag the bypassed checks for compliance audits.
* **Multi-Language Support**: Sanitization and heuristic filters support English, German, French, and Spanish variants.
