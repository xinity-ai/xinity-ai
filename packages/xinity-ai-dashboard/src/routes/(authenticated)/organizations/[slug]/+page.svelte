<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import { organization } from "$lib/auth";

  import OrganizationHeader from "./OrganizationHeader.svelte";
  import EditOrganizationForm from "./EditOrganizationForm.svelte";
  import MembersCard from "./MembersCard.svelte";
  import PendingInvitationsCard from "./PendingInvitationsCard.svelte";
  import DangerZoneCard from "./DangerZoneCard.svelte";
  import RolesInfoDialog from "./RolesInfoDialog.svelte";
  import SsoProvidersSection from "$lib/components/sso/SsoProvidersSection.svelte";
  import { createUrlSearchParamsStore } from "$lib/urlSearchParamsStore";

  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { Eye, Zap } from "@lucide/svelte";

  let { data }: { data: PageData } = $props();

  let showEditForm = $state(false);
  let activating = $state(false);

  const searchParams = createUrlSearchParamsStore();
  let showRolesInfo = $derived($searchParams.roles === "open");

  function openRolesInfo() {
    $searchParams = { ...$searchParams, roles: "open" };
  }

  function closeRolesInfo() {
    const { roles, ...rest } = $searchParams;
    $searchParams = rest;
  }

  // Permission checks: all management actions gated by isActive
  const isActive = $derived(data.isActiveOrganization);
  const isOwner = $derived(data.currentUserRole === "owner");
  const isAdmin = $derived(data.currentUserRole === "admin");
  const isOwnerOrAdmin = $derived(isOwner || isAdmin);

  const canEditOrganization = $derived(isActive && isOwnerOrAdmin);
  const canDeleteOrganization = $derived(isActive && isOwner);
  const canInviteMembers = $derived(isActive && isOwnerOrAdmin);
  const canRemoveMembers = $derived(isActive && isOwnerOrAdmin);
  const canChangeRoles = $derived(isActive && isOwner);

  async function activateOrganization() {
    activating = true;
    const result = await organization.setActive({ organizationId: data.organization?.id ?? "" });
    if (result.data) {
      await invalidateAll();
    }
    activating = false;
  }
</script>

<svelte:head>
  <title>Org: {data.organization?.name}</title>
</svelte:head>

<div class="container max-w-4xl px-6 py-8 mx-auto">
  {#if !isActive}
    <Alert.Root class="mb-6">
      <Eye class="w-4 h-4" />
      <Alert.Title>Read-only view</Alert.Title>
      <Alert.Description class="flex items-center justify-between gap-4">
        <span>This organization is not currently active. Activate it to make changes.</span>
        <Button size="sm" disabled={activating} onclick={activateOrganization}>
          <Zap class="w-4 h-4" />
          {activating ? "Activating..." : "Activate"}
        </Button>
      </Alert.Description>
    </Alert.Root>
  {/if}

  <OrganizationHeader
    name={data.organization?.name ?? ""}
    slug={data.organization?.slug ?? ""}
    logo={data.organization?.logo}
    canEdit={canEditOrganization}
    onEditClick={() => (showEditForm = !showEditForm)}
  />

  {#if showEditForm}
    <EditOrganizationForm
      organizationId={data.organization?.id ?? ""}
      initialName={data.organization?.name ?? ""}
      initialLogo={data.organization?.logo ?? ""}
      onClose={() => (showEditForm = false)}
    />
  {/if}

  <div class="grid gap-6">
    <MembersCard
      organizationId={data.organization?.id ?? ""}
      members={data.organization?.members ?? []}
      canInvite={canInviteMembers}
      canRemove={canRemoveMembers}
      canChangeRoles={canChangeRoles}
      activeRole={data.currentUserRole}
      onOpenRolesInfo={openRolesInfo}
    />

    <PendingInvitationsCard
      invitations={data.invitations ?? []}
      readOnly={!isActive}
    />

    {#if data.ssoSelfManage && isActive && isOwnerOrAdmin}
      <SsoProvidersSection organizationId={data.organization?.id ?? ""} />
    {/if}

    {#if canDeleteOrganization}
      <DangerZoneCard
        organizationId={data.organization?.id ?? ""}
      />
    {/if}
  </div>
</div>

<RolesInfoDialog open={showRolesInfo} onClose={closeRolesInfo} />
