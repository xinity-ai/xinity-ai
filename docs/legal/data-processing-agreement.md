# Xinity AI — Standard Data Processing Agreement

**Version:** 1.1.0
**Published:** March 2026
**Status:** Draft — pending legal review before use

---

## How to use this document

This is Xinity AI's standard Data Processing Agreement ("**DPA**"). It applies whenever a customer ("**Controller**") deploys and operates the Xinity AI platform and that deployment may involve the processing of personal data subject to the GDPR or equivalent legislation.

To execute this DPA, both parties complete and sign the signature block in Section 8. No other negotiation is required unless the customer's circumstances require deviation from the standard terms; in such cases the Parties may agree a written amendment.

---

## 1. Definitions

**"Agreement"** means the software license or supply agreement between Xinity AI and the Controller under which the Platform is made available.

**"Controller"**, **"Processor"**, **"Personal Data"**, **"Processing"**, **"Data Subject"**, **"Personal Data Breach"**, and **"Supervisory Authority"** have the meanings given to them in Regulation (EU) 2016/679 (the **"GDPR"**) and any applicable national implementation.

**"Platform"** means the Xinity AI software suite (Gateway, Dashboard, Daemon, CLI, and associated components) supplied under the Agreement, as described in the technical documentation published at the project repository.

**"Customer Infrastructure"** means the servers, databases, networks, and cloud or on-premises environments owned or controlled by the Controller on which the Platform is deployed and operated.

**"Xinity AI"** or **"Processor"** means the legal entity that supplies the Platform under the Agreement.

**"Controller"** means the customer entity that installs and operates the Platform on Customer Infrastructure, as identified in the signature block.

---

## 2. Nature, Purpose, and Scope of Processing

### 2.1 Supply model

Xinity AI supplies software. The Controller installs, configures, and operates the Platform on Customer Infrastructure. Xinity AI does not operate, host, or manage Customer Infrastructure on behalf of the Controller, and does not have access to data processed within it.

### 2.2 Nature of processing

When operated by the Controller, the Platform:

- Routes AI inference requests (which may contain personal data) from the Controller's applications to inference models running on Customer Infrastructure
- Logs inference request and response data to a PostgreSQL database on Customer Infrastructure for the purposes of usage tracking, cost attribution, and data quality review
- Manages model deployment lifecycle across inference nodes within Customer Infrastructure

### 2.3 Data residency

All data processed by the Platform, including inference inputs, outputs, and call logs, remains at all times within Customer Infrastructure. Xinity AI has no logical, physical, or network access to the Controller's inference data, database, object storage, or inference nodes.

### 2.4 No transmission to Xinity AI

The Platform does not transmit personal data or inference data to Xinity AI. License key validation is performed offline using cryptographic signature verification; no network call to Xinity AI systems is made during normal operation. Xinity AI receives no telemetry or usage data from deployed instances.

### 2.5 Integration touchpoints and customer responsibility

The Platform integrates with infrastructure components that the Controller supplies and configures. Xinity AI makes no assumption about the geographic location of these components; the Controller is responsible for ensuring they meet applicable data residency requirements.

| Component | Role | Data involved |
|---|---|---|
| PostgreSQL | Coordination database; call logs, users, deployments, API keys | May contain personal data in call logs |
| Redis | Ephemeral gateway state (auth cache, load balancer state) | Contains API key identifiers and ephemeral session state; no inference content |
| Ollama / vLLM inference drivers | Execute model inference on customer hardware | Receive full inference requests; run on customer-managed nodes |
| SeaweedFS / S3-compatible store | Optional multimodal image storage | Contains images submitted in inference requests; customer-managed; not enabled by default |

### 2.6 Activities that transmit data outside the customer's network

The following activities, whether part of initial setup or optional runtime features, may cause data to be transmitted beyond the Customer Infrastructure perimeter. The Controller is solely responsible for their configuration and the data protection implications of enabling them.

**Model downloads (vLLM driver):** When the vLLM inference driver is used, the Daemon downloads model weights from external model registries, typically HuggingFace (`huggingface.co`). This occurs during model installation, not during inference. The data transmitted is limited to the download request itself (model identifier, authentication token if the model is gated). The Controller should review HuggingFace's privacy policy and terms of service, as that relationship is directly between the Controller and HuggingFace. Ollama manages its own model registry separately; the same consideration applies.

**Models requiring custom code (`trust-remote-code`):** Certain models hosted on external registries include custom Python code that must be executed locally during model loading. The Platform warns the operator when a model requires this. The Controller accepts sole responsibility for the security implications of executing third-party model code on their infrastructure. This is not a data processing concern but an operational security one.

**Web search (`web_search` tool):** When `WEB_SEARCH_ENGINE_URL` is configured, the Gateway sends search queries to the configured SearXNG instance. SearXNG forwards queries to external search providers as part of its normal operation. Search queries may contain content derived from inference requests.

**Web fetch (`web_fetch` tool):** When enabled, the Gateway makes outbound HTTP requests to URLs provided by the LLM during inference.

The web search and web fetch tools are disabled unless explicitly configured and are not required for core inference functionality. Model downloads are a necessary part of using the vLLM driver but contain no personal data from inference requests.

### 2.7 Categories of data and data subjects

The categories of personal data and data subjects processed through the Platform are determined entirely by the Controller based on the content of inference requests it submits. Xinity AI has no visibility into these categories and makes no determination about them.

### 2.8 Duration

Processing continues for the duration of the Agreement or until the Controller ceases to operate the Platform, whichever is earlier.

---

## 3. Processor Obligations

### 3.1 Instructions

The Processor shall process personal data only in accordance with the Controller's documented instructions. Given the supply model described in Section 2, the Processor's primary obligation is to ensure the Platform is designed and built so that it processes data only within Customer Infrastructure and does not transmit it to external parties. The Platform's source code is available for independent verification of this behavior.

### 3.2 Confidentiality of processing

The Processor shall ensure that personnel authorized to access the Platform's source code and release process are subject to appropriate confidentiality obligations.

### 3.3 Technical and organisational measures

The Processor implements the following security measures in the Platform and its development process:

| Measure | Implementation |
|---|---|
| Local-only data processing | The Platform is architected to process all inference data within Customer Infrastructure. No outbound data paths to Xinity AI are implemented. |
| Offline license validation | Ed25519 cryptographic verification against an embedded public key; no network call to Processor systems. |
| API key hashing | Gateway API keys stored as bcrypt hashes; only a short non-secret specifier used for lookup. |
| Secrets management at installation | The CLI stores service credentials in mode-600 systemd credential files, separate from non-secret configuration. |
| Binary integrity | Release binaries distributed with SHA-256 checksums, verified by the CLI before installation. Binaries are cryptographically signed. |
| Source availability | Platform source code is available for inspection, enabling the Controller to independently verify data handling behavior. |
| Secure development practices | The Processor maintains documented development, code review, and release processes designed to prevent the introduction of unauthorized data exfiltration paths. |

The Controller is responsible for the security of Customer Infrastructure, including network controls, database access controls, secrets management, backup, and patching of the underlying operating system and services.

### 3.4 Sub-processors

Xinity AI does not engage sub-processors that have access to the Controller's personal data, because Xinity AI does not process that data on its own systems. Third-party open-source components included in the Platform are listed in the project's published dependency manifests and do not result in data transfer to any third party.

### 3.5 Data subject rights

Because the Processor does not hold or have access to Controller data, requests from data subjects must be handled by the Controller directly, using the data management tools available within the Platform (such as call log access and deletion via the Dashboard) or directly against Customer Infrastructure.

### 3.6 Security incident notification

The Processor shall notify the Controller without undue delay upon becoming aware of a confirmed security vulnerability in the Platform that materially affects the confidentiality, integrity, or availability of personal data processed by the Controller. Notification will be provided through the Processor's published security disclosure channel.

The Controller is solely responsible for detecting, containing, and notifying relevant Supervisory Authorities of any Personal Data Breach occurring within Customer Infrastructure.

### 3.7 Return and deletion

The Processor does not hold Controller data. Obligations to delete or return personal data upon termination of the Agreement rest with the Controller, who retains full control of Customer Infrastructure and its contents throughout the term.

### 3.8 Audit and cooperation

No more than once per calendar year, and upon reasonable prior written notice, the Controller may request written confirmation from the Processor that the Platform operates as described in this DPA. The Processor shall respond within 30 business days. The Controller may also independently verify the Platform's data handling behavior by reviewing the published source code at any time.

The Processor shall provide the Controller with such information as is reasonably necessary to demonstrate compliance with this DPA and shall cooperate with any audit conducted by a Supervisory Authority.

---

## 4. Controller Responsibilities

### 4.1 Infrastructure security

The Controller is responsible for the security, availability, and integrity of Customer Infrastructure, including hardware, operating system, network, PostgreSQL, Redis, and any configured object storage.

### 4.2 Access control

The Controller manages all user accounts, API keys, role assignments, and network access controls within the Platform.

### 4.3 GDPR compliance

The Controller is the data controller for all personal data processed through the Platform. The Controller is responsible for maintaining a lawful basis for processing, providing required notices to data subjects, and complying with all applicable data protection obligations.

### 4.4 Third-party integrations and external services

The Controller is responsible for the data protection compliance of any third-party services contacted by the Platform during operation. This includes but is not limited to: database providers, Redis providers, object storage providers, SearXNG instances, and model registries such as HuggingFace (contacted by the vLLM driver when downloading models). The Controller should ensure adequate contractual protections are in place with any such services, and review their respective privacy policies and terms of service independently.

### 4.5 Configuration

The Controller is responsible for configuring the Platform appropriately for its data protection requirements, including call log retention periods, role-based access controls, and network segmentation.

---

## 5. International Data Transfers

All data processing described in this DPA occurs within Customer Infrastructure. The geographic location of that infrastructure is determined entirely by the Controller. Any international transfers of personal data arise from the Controller's choice of infrastructure location or third-party integrations, not from any action by Xinity AI.

---

## 6. Term and Termination

This DPA remains in force for the duration of the Agreement. It terminates automatically upon termination or expiry of the Agreement. Obligations relating to confidentiality and audit rights survive termination.

---

## 7. Governing Law

*[To be completed. Recommended: the governing law of the Agreement.]*

---

## 8. Execution

By signing below, the Parties agree to be bound by this DPA as of the Effective Date stated.

| | **Controller** | **Processor (Xinity AI)** |
|---|---|---|
| **Legal entity name** | | |
| **Registered address** | | |
| **Signatory name** | | |
| **Title** | | |
| **Signature** | | |
| **Date** | | |

**Effective Date:** _______________

---

*This is a standard template published by Xinity AI. It does not constitute legal advice. Before execution, both parties should review it with qualified legal counsel, particularly where processing involves sensitive categories of personal data or cross-border data transfers.*
