<script lang="ts">
  import EmailButton from "./partials/EmailButton.svelte";
  import EmailLayout from "./partials/EmailLayout.svelte";
  import EmailText from "./partials/EmailText.svelte";

  const {
    memberName = "",
    eventType = "joined",
    role = "",
    orgName = "",
    dashboardUrl = "",
    appName = "Xinity",
    preferencesUrl = "",
  }: {
    memberName: string;
    eventType: "joined" | "role_changed" | "removed";
    role: string;
    orgName: string;
    dashboardUrl: string;
    appName: string;
    preferencesUrl: string;
  } = $props();

  const titles: Record<string, string> = {
    joined: "New Member Joined",
    role_changed: "Member Role Updated",
    removed: "Member Removed",
  };

  const title = $derived(titles[eventType] ?? "Member Update");
</script>

<EmailLayout {title} preview="{title} in {orgName}" {appName} {preferencesUrl}>
  <EmailText style="font-size:20px;font-weight:bold">{title}</EmailText>
  {#if eventType === "joined"}
    <EmailText>
      <strong>{memberName}</strong> has joined <strong>{orgName}</strong> as <strong>{role}</strong>.
    </EmailText>
  {:else if eventType === "role_changed"}
    <EmailText>
      <strong>{memberName}</strong>'s role in <strong>{orgName}</strong> has been changed to <strong>{role}</strong>.
    </EmailText>
  {:else if eventType === "removed"}
    <EmailText>
      <strong>{memberName}</strong> has been removed from <strong>{orgName}</strong>.
    </EmailText>
  {:else}
    <EmailText>A member update has occurred.</EmailText>
  {/if}
  <EmailButton href={dashboardUrl}>View Organization</EmailButton>
</EmailLayout>
