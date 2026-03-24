<script lang="ts">
  import EmailFooter from "./partials/EmailFooter.svelte";
  import EmailHeader from "./partials/EmailHeader.svelte";

  const {
    memberName = "",
    eventType = "joined",
    role = "",
    orgName = "",
    dashboardUrl = "",
  }: {
    memberName: string;
    eventType: "joined" | "role_changed" | "removed";
    role: string;
    orgName: string;
    dashboardUrl: string;
  } = $props();

  const titles: Record<string, string> = {
    joined: "New Member Joined",
    role_changed: "Member Role Updated",
    removed: "Member Removed",
  };

  const title = $derived(titles[eventType] ?? "Member Update");
</script>

<mjml>
  <mj-head>
    <mj-title>{title}</mj-title>
    <mj-preview>{title} in {orgName}</mj-preview>
  </mj-head>

  <mj-body background-color="#f4f4f4">
    <EmailHeader />

    <mj-section background-color="#ffffff" padding="20px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold">{title}</mj-text>
        {#if eventType === "joined"}
          <mj-text>
            <strong>{memberName}</strong> has joined <strong>{orgName}</strong> as <strong>{role}</strong>.
          </mj-text>
        {:else if eventType === "role_changed"}
          <mj-text>
            <strong>{memberName}</strong>'s role in <strong>{orgName}</strong> has been changed to <strong>{role}</strong>.
          </mj-text>
        {:else if eventType === "removed"}
          <mj-text>
            <strong>{memberName}</strong> has been removed from <strong>{orgName}</strong>.
          </mj-text>
        {:else}
          <mj-text>A member update has occurred.</mj-text>
        {/if}
        <mj-button href={dashboardUrl} background-color="#007BFF">View Organization</mj-button>
      </mj-column>
    </mj-section>

    <EmailFooter />
  </mj-body>
</mjml>
