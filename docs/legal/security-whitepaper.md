# Xinity AI — Security & Architecture Whitepaper

**Version:** 1.1.0
**Date:** March 2026
**Status:** Draft — pending legal review

---

## 1. Executive Summary

Xinity AI is a self-hostable AI orchestration platform designed for organizations with strict data residency, sovereignty, and security requirements. The entire stack — inference, API routing, model management, and the management dashboard — executes within the customer's own infrastructure. No inference data, prompts, or model outputs are ever transmitted to Xinity.

This document describes the architecture, data flows, and security properties relevant to enterprise procurement and security review.

---

## 2. Architecture Overview

Xinity AI consists of four services that the customer installs and operates on their own hardware:

| Service | Role |
|---|---|
| **Gateway** | OpenAI-compatible API endpoint; routes and load-balances inference requests to inference nodes |
| **Dashboard** | Web-based management UI and REST/RPC API; handles users, organizations, model deployments, API keys, and call data |
| **Daemon** | Runs on each inference node; manages model installation and lifecycle via Ollama and vLLM |
| **Xinity CLI** | Operator tool for installing, configuring, and managing services on Linux hosts |

All services coordinate through a shared PostgreSQL database that the customer hosts. There is no external coordination endpoint. Redis is used by the Gateway for ephemeral state (authentication caching, load balancer coordination). Both PostgreSQL and Redis are customer-managed.

An optional self-hosted object store (SeaweedFS) can be configured for multimodal image storage. This is also customer-managed; no images are transmitted to Xinity.

---

## 3. Data Flows and Boundaries

### 3.1 No telemetry or callbacks to Xinity

Xinity does not receive any telemetry, usage metrics, error reports, or operational data from customer installations. Prometheus metrics (exposed at `/metrics`) and structured logs (Pino) are available within the customer's environment for their own observability stack. These are not transmitted to Xinity.

### 3.2 License validation

Enterprise license keys are validated entirely offline using Ed25519 cryptographic signature verification. The public key is embedded in the Dashboard binary at build time. License validation never makes a network request to Xinity servers. Air-gapped deployments are fully supported.

### 3.3 Infrastructure integrations

Xinity AI is a software platform, not a managed service. All infrastructure components are supplied, configured, and hosted by the customer. Xinity makes no assumption about the geographic location or hosting environment of any of these components. The customer is solely responsible for their data residency and security posture.

| Component | Role | Notes |
|---|---|---|
| **PostgreSQL** | Shared coordination database; stores call logs, users, deployments, API keys | Customer-managed; location determined by customer |
| **Redis** | Ephemeral gateway state: auth cache, load balancer counters, responses store | Customer-managed |
| **Ollama / vLLM** | Local inference drivers | Run on customer-managed inference nodes; model weights and inference data do not leave those nodes |
| **SeaweedFS / S3** | Optional object store for multimodal image data | Customer-managed; not configured by default |

### 3.4 Inference data plane

In the default configuration, all inference traffic flows within the customer's infrastructure:

```
Application → Gateway (customer-hosted) → Ollama / vLLM (customer-hosted)
```

After each request completes, the Gateway logs call data — including input messages and output — to the `apiCall` table in the customer's PostgreSQL database. This data is stored on customer infrastructure and is accessible only to authorized users of that installation.

### 3.5 Image data (multimodal)

When SeaweedFS is configured, images submitted in multimodal requests are uploaded to the customer's SeaweedFS instance and referenced by SHA-256 hash in the call log. Inference nodes always receive full data URIs. No image data is transmitted to Xinity.

### 3.6 Optional web search and web fetch tools (Responses API)

When the Responses API is used with tools enabled, the following optional capabilities may cause data to leave the customer's internal network perimeter:

**Web search (`web_search` tool):** If `WEB_SEARCH_ENGINE_URL` is configured, the Gateway sends search queries to the configured SearXNG instance. SearXNG is a metasearch engine that forwards queries to external search providers (e.g. Google, Bing). Depending on the customer's SearXNG deployment:
- Self-hosted SearXNG: queries stay within the customer's network until SearXNG forwards them to external search providers, which is inherent to how web search functions.
- Third-party SearXNG instance: queries are sent to that instance directly.

Search queries submitted by the LLM may contain content derived from the original inference request. The customer is responsible for the configuration and data handling of their SearXNG instance.

**Web fetch (`web_fetch` tool):** If enabled, the Gateway fetches content from arbitrary URLs provided by the LLM during inference. HTTP requests to those URLs originate from the Gateway's host.

Both tools are entirely optional. They are only active when `WEB_SEARCH_ENGINE_URL` is configured and the Responses API endpoint is used with tools enabled. Neither is required for core chat completion, embeddings, or reranking functionality.

---

## 4. Security Controls

### 4.1 Authentication and access control

The Dashboard uses Better Auth with support for:

- Username/password with TOTP two-factor authentication
- Passkeys (WebAuthn / FIDO2)
- SSO via OIDC and SAML (enterprise tier)
- API key authentication for programmatic access

Five roles control access to resources: **owner**, **admin**, **member**, **labeler**, and **viewer**. Permissions are enforced server-side on every API call.

### 4.2 API key security

Gateway API keys are stored as bcrypt hashes. A 25-character specifier prefix allows fast lookup without exposing the full key. Keys are verified against the hash on every request.

### 4.3 Binary signing and supply chain

All release binaries are signed and distributed with SHA-256 checksums. The Xinity CLI verifies the SHA-256 hash of every binary it downloads before installation. Secrets in systemd service configurations are stored in mode-600 credential files using systemd's `LoadCredential`, separate from non-secret environment variables.

### 4.4 Persistent call logging

Inference request and response data is logged to PostgreSQL within the customer's infrastructure. The customer controls retention, access, and deletion of this data. No prompt data is written to disk on inference nodes themselves; Ollama and vLLM serve requests in memory. The call log in PostgreSQL is the authoritative record.

---

## 5. Deployment Models

| Mode | Description |
|---|---|
| **On-premises** | All services run on customer-managed hardware within the corporate network |
| **Private VPC** | Services deployed in a customer-controlled cloud environment (no Xinity involvement) |
| **Air-gapped** | Fully supported; license validation, binary distribution, and model catalog can all operate without internet access |
| **NixOS** | Native NixOS module provided for declarative, reproducible deployments via flake |

---

## 6. What Xinity Does Not Have Access To

To be explicit:

- Xinity does not have access to inference requests or responses
- Xinity does not have access to the customer's database, Redis, or object store
- Xinity does not receive telemetry or operational metrics from deployed instances
- Xinity does not have remote access to customer infrastructure
- Xinity does not act as a sub-processor for customer data in any way

The customer is the sole operator of the infrastructure on which Xinity AI runs.

---

*This document is a draft provided for informational purposes during procurement and security review. It should be reviewed alongside the Data Processing Agreement and the technical architecture documentation in the Xinity AI repository.*
