<script lang="ts">
  import { artifactEntryName, type AuditPackData } from "./audit-pack";

  const { data }: { data: AuditPackData } = $props();

  const ORGANIZATIONAL_TITLES: Record<string, string> = {
    "dpia": "Data protection impact assessment (DPIA)",
    "usage-policy": "AI usage policy",
    "training-records": "AI literacy training records",
    "due-diligence": "Model due-diligence assessment",
    "breach-procedure": "Breach documentation procedure",
    "dsr-procedure": "Data subject rights procedure",
  };

  function fmtDate(d: Date | string): string {
    return new Date(d).toISOString().slice(0, 10);
  }
  function fmtDateTime(d: Date | string): string {
    return new Date(d).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
  const enabledDeployments = $derived(data.modelRegister.deployments.filter((d) => d.enabled && !d.deletedAt));
</script>

<header>
  <h1>Audit Evidence Pack</h1>
  <p class="subtitle">{data.cover.organizationName}</p>
  <p>
    Reporting period: <strong>{fmtDate(data.cover.from)}</strong> to <strong>{fmtDate(data.cover.to)}</strong><br />
    Generated: {fmtDateTime(data.cover.generatedAt)} ·
    Platform version {data.cover.platformVersion} ·
    Legal mapping {data.cover.legalMappingVersion}<br />
    Organization ID: <code>{data.cover.organizationId}</code>
    {#if data.cover.instanceId}
      · Instance ID: <code>{data.cover.instanceId}</code>
    {/if}
  </p>
  <div class="disclaimer">
    This document is machine-generated evidence assembled from the operational data of an
    on-premises Xinity AI installation, together with the organization's uploaded documents.
    It supports — but does not replace — the controller's own compliance assessment.
    A complete evidence set does not constitute a finding of compliance; that conclusion
    rests with the organization's data protection officer and legal counsel.
  </div>
</header>

<section>
  <h2>1. Controller Position &amp; Architecture</h2>
  <p class="ref">GDPR Art. 4(7) · DSK Orientierungshilfe KI (May 2024), Rn. 16, 20, 32</p>
  <p>
    The Xinity AI platform operates entirely on infrastructure controlled by
    {data.cover.organizationName}. Inference requests, prompts, completions, and management
    data are processed and stored exclusively on customer-managed systems; no inference data
    is transmitted to the software vendor. When an AI application is operated exclusively for
    the organization's own purposes on its own servers, the organization is, as a rule, the
    sole controller (DSK, Rn. 32). The German data protection authorities describe technically
    closed, self-hosted AI systems of this kind as preferable ("vorzugswürdig") from a data
    protection perspective.
  </p>
  <p>
    Evidence posture at generation time: <strong>{data.cover.posture.pass} of
    {data.cover.posture.total}</strong> checks evidence-complete,
    {data.cover.posture.warn} needing attention, {data.cover.posture.fail} open gaps
    (detailed in section 9).
  </p>
</section>

<section>
  <h2>2. AI System Register</h2>
  <p class="ref">Evidence E10, E12 · ISO/IEC 42001 · EU AI Act Art. 26 readiness</p>
  <table>
    <thead>
      <tr><th>Deployment</th><th>Model</th><th>Catalog source</th><th>Status</th><th>Replicas</th><th>Created</th></tr>
    </thead>
    <tbody>
      {#each data.modelRegister.deployments as d}
        <tr>
          <td>{d.name} (<code>{d.publicSpecifier}</code>)</td>
          <td>{d.catalog.found ? `${d.catalog.modelName} (${d.catalog.type}, ${d.catalog.weightGb} GB)` : d.specifier ?? "unknown"}</td>
          <td>
            {#if d.catalog.found && d.catalog.sourceUrl}
              <a href={d.catalog.sourceUrl}>{d.catalog.sourceUrl}</a>
            {:else}
              <em>not in catalog</em>
            {/if}
          </td>
          <td>{d.deletedAt ? `removed ${fmtDate(d.deletedAt)}` : d.enabled ? "enabled" : "disabled"}</td>
          <td>{d.replicas}</td>
          <td>{fmtDate(d.createdAt)}</td>
        </tr>
      {:else}
        <tr><td colspan="6"><em>No model deployments in the reporting period.</em></td></tr>
      {/each}
    </tbody>
  </table>

  <h3>Inference infrastructure (shared cluster)</h3>
  <table>
    <thead><tr><th>Node</th><th>GPUs</th><th>Drivers</th><th>Available</th></tr></thead>
    <tbody>
      {#each data.modelRegister.nodes as n}
        <tr>
          <td>{n.machineName ?? n.host}</td>
          <td>{n.gpuCount} ({JSON.stringify(n.gpus)})</td>
          <td>{JSON.stringify(n.driverVersions)}</td>
          <td>{n.available ? "yes" : "no"}</td>
        </tr>
      {:else}
        <tr><td colspan="4"><em>No inference nodes registered.</em></td></tr>
      {/each}
    </tbody>
  </table>

  {#if data.modelRegister.usage.length > 0}
    <h3>Processing volume in period</h3>
    <table>
      <thead><tr><th>Model</th><th>Calls</th><th>Logged calls</th><th>Input tokens</th><th>Output tokens</th></tr></thead>
      <tbody>
        {#each data.modelRegister.usage as u}
          <tr><td>{u.model}</td><td>{u.totalCalls}</td><td>{u.loggedCalls}</td><td>{u.inputTokens}</td><td>{u.outputTokens}</td></tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<section>
  <h2>3. Records of Processing — Technical Annex</h2>
  <p class="ref">Evidence E1 · GDPR Art. 30</p>
  <p>
    Data categories processed by the platform: inference content (prompts, completions, and
    request metadata, stored only for API keys with data collection enabled), usage accounting
    (token counts and durations, no content), uploaded images (customer object store),
    user account data (name, email, authentication factors), and administrative audit events.
    Recipients: none — all processing occurs on customer-controlled infrastructure.
    Storage location: customer-managed PostgreSQL{data.ropa.applications.length > 0 ? " serving the applications below" : ""}.
  </p>
  <h3>Purposes (AI applications)</h3>
  <table>
    <thead><tr><th>Application</th><th>Description</th><th>Since</th></tr></thead>
    <tbody>
      {#each data.ropa.applications as a}
        <tr><td>{a.name}</td><td>{a.description ?? "—"}</td><td>{fmtDate(a.createdAt)}</td></tr>
      {:else}
        <tr><td colspan="3"><em>No applications registered.</em></td></tr>
      {/each}
    </tbody>
  </table>
  <h3>API keys and content-logging consent</h3>
  <table>
    <thead><tr><th>Key</th><th>Prefix</th><th>Enabled</th><th>Stores content</th><th>Created</th></tr></thead>
    <tbody>
      {#each data.ropa.apiKeys as k}
        <tr><td>{k.name}</td><td><code>{k.specifier}</code></td><td>{k.enabled ? "yes" : "no"}</td><td>{k.collectData ? "yes" : "no"}</td><td>{fmtDate(k.createdAt)}</td></tr>
      {:else}
        <tr><td colspan="5"><em>No API keys.</em></td></tr>
      {/each}
    </tbody>
  </table>
  <p>
    Retention per data category:
    {#if data.ropa.retentionDays}
      inference content {data.ropa.retentionDays.apiCall === null ? "kept until manual deletion (explicitly configured)" : `deleted after ${data.ropa.retentionDays.apiCall} days`};
      images {data.ropa.retentionDays.media === null ? "follow the inference content period" : `deleted after ${data.ropa.retentionDays.media} days`};
      usage aggregates (no personal-data content) are retained for accounting.
    {:else}
      <strong>no retention policy configured — open gap.</strong>
    {/if}
  </p>
</section>

<section>
  <h2>4. Technical &amp; Organizational Measures</h2>
  <p class="ref">Evidence E3 · GDPR Art. 32</p>
  <ul>
    <li>API authentication: bcrypt-hashed keys; the full key is shown once and never stored.</li>
    <li>Member authentication: {data.toms.memberAuth.withTwoFactor} of {data.toms.memberAuth.total} members with TOTP 2FA, {data.toms.memberAuth.withPasskey} with passkeys (WebAuthn/FIDO2){data.toms.ssoProviders.length > 0 ? `; SSO delegated to ${data.toms.ssoProviders.map((s) => s.domain).join(", ")}` : ""}.</li>
    <li>Multi-tenancy: every record is scoped to an organization; cross-organization access is rejected at the API layer.</li>
    <li>Administrative audit trail: {data.toms.auditLogActive ? "active (see section 6)" : "no events in the reporting period"}.</li>
    <li>Transport security and at-rest encryption are operated by the customer (reverse proxy TLS, database encryption); see the Xinity Security Whitepaper for the reference architecture. Air-gapped operation is supported; the platform performs no vendor callbacks.</li>
  </ul>
  <h3>Role-based access control matrix</h3>
  <table>
    <thead><tr><th>Role</th><th>Permissions</th></tr></thead>
    <tbody>
      {#each data.toms.rbacMatrix as r}
        <tr>
          <td>{r.role}</td>
          <td class="small">{Object.entries(r.permissions).map(([res, actions]) => `${res}: ${actions.join("/")}`).join("; ")}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>

<section>
  <h2>5. Retention Policy &amp; Enforcement</h2>
  <p class="ref">Evidence E4 · GDPR Art. 5(1)(e), Art. 5(2)</p>
  {#if data.retention.policy}
    <p>
      Policy (last updated {fmtDate(data.retention.policy.updatedAt)}):
      inference content {data.retention.policy.apiCallRetentionDays === null ? "kept until manual deletion" : `${data.retention.policy.apiCallRetentionDays} days`},
      media {data.retention.policy.mediaRetentionDays === null ? "follows inference content" : `${data.retention.policy.mediaRetentionDays} days`}.
    </p>
  {:else}
    <p><strong>No retention policy configured — open gap.</strong></p>
  {/if}
  <h3>Purge runs in period (enforcement evidence)</h3>
  <table>
    <thead><tr><th>Started</th><th>Finished</th><th>Calls deleted</th><th>Images deleted</th><th>Result</th></tr></thead>
    <tbody>
      {#each data.retention.runs as r}
        <tr>
          <td>{fmtDateTime(r.startedAt)}</td>
          <td>{r.finishedAt ? fmtDateTime(r.finishedAt) : "—"}</td>
          <td>{r.deletedApiCalls}</td>
          <td>{r.deletedMediaObjects}</td>
          <td>{r.error ?? "ok"}</td>
        </tr>
      {:else}
        <tr><td colspan="5"><em>No purge runs in the reporting period.</em></td></tr>
      {/each}
    </tbody>
  </table>
</section>

<section>
  <h2>6. Access &amp; Audit Report</h2>
  <p class="ref">Evidence E11 · GDPR Art. 32</p>
  <h3>Members</h3>
  <table>
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>2FA</th><th>Passkeys</th></tr></thead>
    <tbody>
      {#each data.access.members as m}
        <tr><td>{m.name}</td><td>{m.email}</td><td>{m.role}</td><td>{m.twoFactorEnabled ? "yes" : "no"}</td><td>{m.passkeys}</td></tr>
      {/each}
    </tbody>
  </table>
  <p>
    Dashboard sessions in period: {data.access.sessionStats.sessions} from
    {data.access.sessionStats.distinctIps} distinct IP addresses.
  </p>
  <h3>Administrative audit trail ({data.access.auditTotalInRange} events in period{data.access.auditTotalInRange > data.access.auditEntries.length ? `, newest ${data.access.auditEntries.length} shown — full extract in evidence/access.json` : ""})</h3>
  <table>
    <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>
    <tbody>
      {#each data.access.auditEntries as e}
        <tr>
          <td>{fmtDateTime(e.createdAt)}</td>
          <td>{e.actorEmail ?? "system"}</td>
          <td><code>{e.action}</code></td>
          <td class="small">{e.details ? JSON.stringify(e.details) : ""}</td>
        </tr>
      {:else}
        <tr><td colspan="4"><em>No audit events in the reporting period.</em></td></tr>
      {/each}
    </tbody>
  </table>
</section>

<section>
  <h2>7. EU AI Act Classification: Deployer Position</h2>
  <p class="ref">Evidence E12 · Commission GPAI guidelines (July 2025) · EU AI Act Ch. V</p>
  <p>
    {data.cover.organizationName} operates pre-trained models obtained from documented upstream
    sources (section 2) without modification of the model weights through the platform. Under the
    European Commission's guidelines for providers of general-purpose AI models, a downstream
    actor becomes a GPAI model provider only through a significant modification — indicatively,
    fine-tuning exceeding one third of the original model's training compute. No such
    modification is performed by this platform. The organization's position for the deployed
    systems is therefore that of a <strong>deployer</strong> (and, where assistants are offered
    under its own name, provider of the AI <em>system</em>, not of the underlying model).
  </p>
  <ul>
    {#each enabledDeployments as d}
      <li>
        <code>{d.publicSpecifier}</code> — {d.catalog.found ? `catalog model "${d.catalog.modelName}", upstream: ${d.catalog.sourceUrl ?? "n/a"}` : "not in catalog (provenance must be documented separately)"}
      </li>
    {:else}
      <li><em>No enabled deployments at generation time.</em></li>
    {/each}
  </ul>
</section>

<section>
  <h2>8. Transparency Readiness (Art. 50, applicable from 2 Aug 2026)</h2>
  <p class="ref">EU AI Act Art. 50(1), 50(2)</p>
  <p>
    From 2 August 2026, AI systems interacting directly with natural persons must disclose this
    unless obvious, and generated content must be marked machine-readably. Readiness items for
    the applications in section 3: (a) user-facing assistants disclose AI interaction in their
    interface; (b) generated output is marked where technically feasible; (c) disclosure wording
    is part of the AI usage policy. Platform-level marking support is on the Xinity roadmap;
    until then, disclosure is implemented at the application layer.
  </p>
</section>

<section>
  <h2>9. Organizational Evidence Documents</h2>
  <p class="ref">Evidence E2, E5–E9 · GDPR Art. 35, 33(5), 15–22 · EU AI Act Art. 4</p>
  <table>
    <thead><tr><th>Document</th><th>File</th><th>Updated</th><th>Review by</th><th>Note</th></tr></thead>
    <tbody>
      {#each data.artifacts as a}
        <tr>
          <td>{ORGANIZATIONAL_TITLES[a.kind] ?? a.kind}</td>
          <td><code>{artifactEntryName(a.kind, a.fileName)}</code></td>
          <td>{fmtDate(a.updatedAt)}</td>
          <td>{a.reviewBy ?? "—"}</td>
          <td>{a.note ?? ""}</td>
        </tr>
      {:else}
        <tr><td colspan="5"><em>No documents uploaded.</em></td></tr>
      {/each}
    </tbody>
  </table>
  {#if data.missingArtifactKinds.length > 0}
    <h3 class="gap">Open gaps</h3>
    <p>
      The following documents are required evidence and are <strong>not yet provided</strong>.
      They cannot be generated by the platform; they require the organization's input:
    </p>
    <ul>
      {#each data.missingArtifactKinds as kind}
        <li class="gap">{ORGANIZATIONAL_TITLES[kind] ?? kind}</li>
      {/each}
    </ul>
  {/if}
</section>

<footer>
  Generated {fmtDateTime(data.cover.generatedAt)} by Xinity AI {data.cover.platformVersion} ·
  legal mapping version {data.cover.legalMappingVersion} · machine-readable evidence in the
  accompanying <code>evidence/</code> directory · this pack is evidence, not a certification.
</footer>
