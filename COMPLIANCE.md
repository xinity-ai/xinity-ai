# Xinity AI — GDPR & EU AI Act Compliance Guide

**Version:** 0.1.0
**Date:** June 2026
**Status:** Draft — pending legal review
**Audience:** Customers operating Xinity AI on-premises in the EU, their DPOs and auditors, and Xinity contributors implementing the compliance features described in §6.

> **Important:** This document is not legal advice and Xinity AI does not certify your compliance. It maps regulatory requirements to platform capabilities and tells you which evidence the platform can produce for you and which documents your organization must produce itself. The legal assessment always remains with your Data Protection Officer and counsel.

---

## 1. Executive Summary

Xinity AI is built for organizations that cannot send data to the cloud because of law, regulation, or trade secrets. Running AI on your own infrastructure is itself a strong compliance position: the German data protection authorities (DSK) explicitly describe technically closed, self-hosted AI systems as **preferable ("vorzugswürdig") from a data protection perspective** over open cloud systems (DSK Orientierungshilfe KI, May 2024, Rn. 16/20).

But architecture alone does not pass an audit. An auditor asks for **evidence artifacts**: records of processing, a DPIA, retention policies, access controls, an AI system inventory, training records. This document explains:

- which GDPR and EU AI Act obligations actually apply to you as an on-prem operator as of mid-2026 (§2, §3),
- which evidence auditors concretely request (§4),
- which of that evidence Xinity can produce from its operational data today, and which it cannot (§5),
- the compliance features on the Xinity roadmap, including the **Compliance Posture Dashboard** and the **Audit Evidence Pack generator** (§6).

---

## 2. Your Regulatory Position as an On-Prem Operator

### 2.1 Under the GDPR: you are the sole controller

When you run Xinity AI on your own servers for your own purposes, you are, as a rule, the **sole controller** under Art. 4(7) GDPR (DSK Orientierungshilfe KI, Rn. 32). There is no cloud AI vendor acting as your processor, no data processing agreement with a model API provider, and no third-country transfer to assess. The full controller obligation set — legal basis, records of processing, DPIA, technical and organizational measures, data subject rights — falls on your organization alone, and Xinity (the company) never receives your inference data (see the [Security Whitepaper](docs/legal/security-whitepaper.md), §3.1).

### 2.2 Under the EU AI Act: you are a deployer, not a GPAI provider

Self-hosting an unmodified open-weight model **does not** make you a provider of a general-purpose AI model. Under the European Commission's GPAI guidelines (July 2025), a downstream actor becomes a GPAI provider only through a *significant modification* — indicatively, fine-tuning with more than **one third of the original model's training compute**. Typical enterprise fine-tuning is orders of magnitude below this threshold.

Your audit artifact for this question is a short, documented **classification analysis** stating which models you run, where they come from, and that you have not significantly modified them. Xinity's model registry contains the data to substantiate this (§5).

Note: if you expose a self-hosted assistant under your own name to users, you may qualify as the **provider of that AI system** (not of the model) for the Art. 50 transparency duties described below.

---

## 3. What Applies When — EU AI Act Timeline (as of June 2026)

The AI Act applies in stages, and the **Digital Omnibus** (political agreement of 7 May 2026, pending formal adoption) deferred the high-risk obligations. The practical picture for an on-prem deployer:

| Obligation | Article | Applies from | Status mid-2026 |
|---|---|---|---|
| Prohibited AI practices | Art. 5 | 2 Feb 2025 | **In force** — confirm none of your use cases fall under Art. 5 |
| AI literacy | Art. 4 | 2 Feb 2025 | **In force** — role-tailored staff training with internal records; generic awareness material is insufficient (Commission AI Literacy Q&A) |
| GPAI model provider duties | Ch. V | 2 Aug 2025 | In force, but only relevant if you significantly modify models (§2.2). Commission enforcement powers start 2 Aug 2026 |
| Transparency (chatbot disclosure, machine-readable marking of AI-generated output) | Art. 50 | 2 Aug 2026 | **Imminent** — readiness expected at audit; deployments of assistants must disclose AI interaction unless obvious |
| High-risk deployer duties (incl. log retention Art. 26(6), logging Art. 12) | Art. 26 | 2 Dec 2027 (Annex III) / 2 Aug 2028 (Annex I) | Deferred by Digital Omnibus — **readiness item, not a current audit requirement**. Flag employment-related use cases in your AI inventory as future Annex III candidates |

The GDPR has no transition periods: it applies in full, today, and is what a mid-2026 audit will focus on.

---

## 4. What Auditors Actually Ask For

The EDPB ChatGPT taskforce report (May 2024) includes the questionnaire EU data protection authorities use for LLM systems, and EDPB Opinion 28/2024 defines the documentation supervisory authorities verify for AI models. Combined with the DSK guidance, the concrete evidence set is:

| # | Evidence artifact | Legal basis |
|---|---|---|
| E1 | Copy of the **records of processing activities (ROPA)** covering the AI system | Art. 30 GDPR |
| E2 | **Data protection impact assessment (DPIA)** with proof of DPO involvement and periodic review deadlines — the DSK states a DPIA will *frequently* be required for AI deployments | Art. 35 GDPR |
| E3 | Description of **technical and organizational measures (TOMs)** with threat models, calibrated to risk | Art. 32 GDPR |
| E4 | **Retention policy differentiated per data category**, plus evidence that it is enforced | Art. 5(1)(e) GDPR |
| E5 | **Breach documentation** procedures and records | Art. 33(5) GDPR |
| E6 | Working **data subject rights procedures**. For Art. 16/17 these must address the model and stored data themselves — the DSK holds that suppressing outputs via downstream filters does *not* generally constitute erasure | Art. 15–22 GDPR |
| E7 | **Model due-diligence assessment**: a documented evaluation that the sourced model was not developed through unlawful processing of personal data (source of training data, known supervisory authority or court findings) | EDPB Opinion 28/2024, paras 129–130; Arts. 5(1)(a), 5(2), 6 GDPR |
| E8 | **AI usage policy**: documented internal instructions on whether, under which conditions, and for which purposes which AI applications may be used | DSK OH KI, Rn. 36 |
| E9 | **AI literacy training records**, role-tailored | Art. 4 AI Act; DSK OH KI, Rn. 46 |
| E10 | **AI system inventory / register**: which AI systems are deployed, their versions, sources, capabilities, and risk classification | ISO/IEC 42001; Art. 26 readiness |
| E11 | **Access control evidence**: who can access inference data and administration functions, authentication mechanisms | Art. 32 GDPR |
| E12 | **GPAI / deployer classification analysis** (§2.2) | Commission GPAI guidelines, July 2025 |

Two evidentiary principles auditors apply (EDPB taskforce report, paras 7 and 19): **technical impossibility is no excuse** — accountability and data protection by design apply fully to LLM processing — and **the burden of proving that safeguards work lies with you**, the controller. Documented effectiveness evidence is itself an audit requirement.

---

## 5. Mapping: What Xinity Can Evidence Today

### 5.1 Platform data that directly supports audit evidence

All of the following already exists in the shared PostgreSQL database (schemas in `packages/common-db/src/schema/`) and stays entirely on your infrastructure:

| Audit need | Platform source |
|---|---|
| Complete inference lineage — who called which model, when, through which API key and application, with full prompts and completions | `apiCall` table (call_data schema) |
| Per-key logging consent | `aiApiKey.collectData` flag |
| Usage accounting (tokens, calls, duration per org/model/key) | `usageEvent`, `usageSummary` |
| Model inventory with versions, sources, and capability tags | `modelDeployment`, `modelInstallation` + infoserver model catalog (incl. upstream source links, e.g. Hugging Face) |
| Deployment lifecycle and failure history | `modelInstallationState` |
| Hardware footprint (nodes, GPUs, driver versions) | `aiNode` |
| Role-based access control (5 roles: owner, admin, member, labeler, viewer), enforced centrally | `src/lib/roles.ts` + oRPC permission middleware |
| Authentication posture: bcrypt-hashed API keys, 2FA, passkeys, SSO (OIDC/SAML) | Better Auth tables |
| Login access records (IP address, user agent, timestamp) | `session` table |
| Organization-scoped multi-tenancy with cascade deletion | `organizationId` scoping on all core tables |

### 5.2 Known gaps (honest assessment)

These gaps are the roadmap drivers in §6. Until they are closed, your DPO must address them with manual procedures:

1. **No retention or purge mechanism for inference logs.** `apiCall` rows (including full prompts and completions) are stored indefinitely by default. **This is the single most important gap**: an indefinite retention default conflicts with Art. 5(1)(e) GDPR, and a DPA questionnaire (E4) will surface it immediately. *Interim measure: implement scheduled deletion directly against the database and document it in your retention policy.*
2. **No administrative audit trail.** Dashboard operations (deployments created/deleted, role changes, key creation, data exports) are not recorded as audit events. The `"audit-log"` license feature exists in `packages/xinity-ai-dashboard/src/lib/server/license/types.ts` but is not yet implemented.
3. **No per-user DSAR export or deletion.** A single-call export exists (`/data/export/[callId]`); there is no "export/delete all data for person X" function (E6).
4. **No legal-basis tagging** on processing activities or API keys.
5. **No report generation** beyond single-call JSON export and weekly summary emails.

### 5.3 The auto-generation boundary

This boundary is what makes the §6 features honest rather than compliance theater:

**Platform-derivable** (can be generated from operational data, always current): the AI system register (E10), the technical sections of the ROPA (E1 — data categories, storage location, recipients, retention), the TOMs description (E3 — authentication, RBAC matrix, encryption, network architecture, air-gap mode), retention evidence (E4, once §6.1 lands), access control evidence (E11), and the GPAI classification rationale (E12 — models sourced unmodified from the catalog with upstream links).

**Organizational** (requires human judgment and cannot be auto-generated): the DPIA risk assessment and DPO advice (E2), legal basis determinations, breach procedures (E5), the substantive DSR process design (E6), the model due-diligence assessment (E7), the AI usage policy (E8), and training records (E9). The platform can *track and attach* these, but never author them.

---

## 6. Compliance Feature Roadmap

In priority order. Items 1–4 form the core scope ("20% effort, 80% audit impact"); items 5–6 are fast follows.

### 6.1 Retention engine (prerequisite)

Per-organization configurable retention periods for `apiCall` and `mediaObject` data, enforced by a daily purge job, with purge runs recorded so the Audit Evidence Pack can show the policy *and* proof of enforcement (E4). Without this, every other generated artifact documents non-compliance.

### 6.2 Administrative audit log

A new `auditLog` table (timestamp, actor, organization, action, resource type/id, changes) populated via the existing centralized oRPC middleware chain, covering deployments, role and member changes, API key lifecycle, settings changes, and data exports. Activates the existing `"audit-log"` license feature. Answers "who did what, when" — the first request of any ISO 27001/42001 auditor.

### 6.3 Compliance Posture Dashboard

A per-organization page answering "are we in good shape?" at a glance, with two halves:

- **Automated checks**, computed live from platform state: retention configured and running; 2FA/SSO enforcement; all deployed models sourced from the catalog with known upstream; logging consent flags reviewed; TLS configured; admin audit log active.
- **Guided organizational checklist** with document upload slots, tracking the artifacts only you can produce: DPIA (E2), usage policy (E8), training records (E9), due-diligence assessment (E7), breach procedure (E5), DSR procedure (E6). Each item links to the relevant article and a plain-language explanation.

The status indicator always reads **"evidence complete"**, never "compliant" — the legal conclusion stays with your DPO, which is where an auditor expects it.

### 6.4 Audit Evidence Pack generator

One action ("Generate Audit Pack") producing a versioned PDF plus a machine-readable ZIP for a chosen organization and date range:

1. Cover statement on the on-prem architecture and controller position (§2), citing the DSK closed-system preference.
2. AI system register — deployed models, versions, sources, capabilities, deployment history (E10).
3. ROPA technical annex (E1).
4. TOMs annex (E3).
5. Retention policy, configuration, and purge evidence (E4).
6. Access control and RBAC report, audit log extract (E11, §6.2).
7. Deployer / GPAI classification analysis with model provenance (E12).
8. Art. 50 transparency readiness status.
9. The organization's uploaded documents from §6.3, merged in — with **missing artifacts listed explicitly as gaps**, not silently omitted.

Every section is stamped with the regulation articles it evidences and the generation timestamp. The legal mapping is versioned in the document so reports remain interpretable as the Digital Omnibus and Commission guidance evolve.

### 6.5 Data subject rights tooling (fast follow)

Per-person export and deletion across `apiCall`, sessions, keys, and profile data, with deletion receipts recorded in the audit log (E6).

### 6.6 Art. 50 transparency readiness (fast follow — legally live 2 Aug 2026)

Gateway-level support for AI-interaction disclosure and machine-readable marking metadata on generated outputs, configurable per application.

---

## 7. Sources

- EU AI Act (Regulation (EU) 2024/1689): Arts. 4, 5, 26, 50, 113; Digital Omnibus political agreement (7 May 2026) deferring Annex III/I high-risk application dates.
- European Commission, *Guidelines for providers of general-purpose AI models* (July 2025); *AI Literacy — Questions & Answers*.
- EDPB, *Report of the work undertaken by the ChatGPT Taskforce* (May 2024), incl. annexed DPA questionnaire.
- EDPB, *Opinion 28/2024 on certain data protection aspects related to the processing of personal data in the context of AI models* (Dec 2024).
- DSK (Konferenz der unabhängigen Datenschutzaufsichtsbehörden), *Orientierungshilfe KI und Datenschutz* (May 2024); *Orientierungshilfe TOMs für KI-Systeme* (June 2025).
- ISO/IEC 42001:2023 — AI management systems (emerging audit framework for E10).
- Related Xinity documents: [Security Whitepaper](docs/legal/security-whitepaper.md), [Data Processing Agreement](docs/legal/data-processing-agreement.md), [SECURITY.md](SECURITY.md).
