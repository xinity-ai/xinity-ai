<script lang="ts">
  import { onMount } from "svelte";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Card from "$lib/components/ui/card";
  import { roleLabels, roleBadgeVariant, type RoleName } from "$lib/roles";
  import { Search, ChevronDown, ChevronRight, ChevronLeft, X, Users, Shield, HardDrive } from "@lucide/svelte";
  import { toastState } from "$lib/state/toast.svelte";
  import { createUrlSearchParamsStore } from "$lib/urlSearchParamsStore";

  const searchParams = createUrlSearchParamsStore();
  const LIMIT = 25;

  let orgs = $state<any[]>([]);
  let total = $state(0);

  const currentPage = $derived(Number($searchParams.page) || 1);
  const searchValue = $derived($searchParams.search ?? "");

  let searchInputValue = $state($searchParams.search ?? "");
  let searchTimeout: ReturnType<typeof setTimeout> | undefined;
  let expandedOrg = $state<string | null>(null);
  let orgMembers = $state<Record<string, any[]>>({});
  let loadingMembers = $state<Set<string>>(new Set());

  async function fetchOrgs() {
    const result = await orpc.instanceAdmin.listOrganizations({
      page: currentPage,
      limit: LIMIT,
      search: searchValue || undefined,
    });
    if (result.data) {
      orgs = result.data.organizations;
      total = result.data.total;
    }
  }

  onMount(() => {
    void fetchOrgs();
  });

  function onSearchInput(e: Event) {
    searchInputValue = (e.target as HTMLInputElement).value;
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      $searchParams.search = searchInputValue || "";
      delete $searchParams.page;
      void fetchOrgs();
    }, 300);
  }

  function goToPage(p: number) {
    $searchParams.page = String(p);
    void fetchOrgs();
  }

  async function toggleOrg(orgId: string) {
    if (expandedOrg === orgId) {
      expandedOrg = null;
      return;
    }
    expandedOrg = orgId;
    if (!orgMembers[orgId]) {
      loadingMembers = new Set([...loadingMembers, orgId]);
      const result = await orpc.instanceAdmin.getOrganizationMembers({ organizationId: orgId });
      if (result.data) {
        orgMembers[orgId] = result.data.members;
      }
      loadingMembers = new Set([...loadingMembers].filter((id) => id !== orgId));
    }
  }

  async function handleRemoveMember(userId: string, organizationId: string, userName: string) {
    const result = await orpc.instanceAdmin.removeUserFromOrganization({ userId, organizationId });
    if (result.error) {
      toastState.add(result.error.message || "Failed to remove member", "error");
    } else {
      toastState.add(`Removed ${userName}`, "success");
      delete orgMembers[organizationId];
      orgMembers = { ...orgMembers };
      await toggleOrg(organizationId);
      void fetchOrgs();
    }
  }

  async function handleRoleChange(userId: string, organizationId: string, role: string) {
    const result = await orpc.instanceAdmin.updateUserRole({
      userId,
      organizationId,
      role: role as RoleName,
    });
    if (result.error) {
      toastState.add(result.error.message || "Failed to update role", "error");
    } else {
      toastState.add("Role updated", "success");
      delete orgMembers[organizationId];
      orgMembers = { ...orgMembers };
      await toggleOrg(organizationId);
    }
  }

  async function handleToggleSsoSelfManage(orgId: string, enabled: boolean) {
    const result = await orpc.instanceAdmin.setSsoSelfManage({ organizationId: orgId, enabled });
    if (result.error) {
      toastState.add("Failed to update SSO self-management", "error");
    } else {
      toastState.add(enabled ? "SSO self-management enabled" : "SSO self-management disabled", "success");
      void fetchOrgs();
    }
  }

  const totalPages = $derived(Math.ceil(total / LIMIT));
</script>

<Card.Root>
  <Card.Header>
    <div class="flex items-center justify-between">
      <div>
        <Card.Title>Organizations</Card.Title>
        <Card.Description>{total} total organizations</Card.Description>
      </div>
    </div>
    <div class="relative mt-4">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
      <Input
        placeholder="Search by name or slug..."
        value={searchInputValue}
        oninput={onSearchInput}
        class="pl-9"
      />
    </div>
  </Card.Header>
  <Card.Content>
    {#if orgs.length === 0}
      <p class="text-center text-muted-foreground py-8">No organizations found.</p>
    {:else}
      <div class="space-y-2">
        {#each orgs as org (org.id)}
          <div class="border rounded-lg">
            <div
              role="button"
              tabindex="0"
              class="w-full flex items-center justify-between p-4 hover:bg-muted/50 text-left cursor-pointer"
              onclick={() => toggleOrg(org.id)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleOrg(org.id); } }}
            >
              <div class="flex items-center gap-3">
                {#if expandedOrg === org.id}
                  <ChevronDown class="w-4 h-4 text-muted-foreground" />
                {:else}
                  <ChevronRight class="w-4 h-4 text-muted-foreground" />
                {/if}
                <div>
                  <span class="font-medium">{org.name}</span>
                  <span class="ml-2 text-sm text-muted-foreground">/{org.slug}</span>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <Button
                  variant={org.ssoSelfManage ? "default" : "outline"}
                  size="sm"
                  class="gap-1.5"
                  title={org.ssoSelfManage ? "SSO self-management enabled, click to disable" : "SSO self-management disabled, click to enable"}
                  onclick={(e: MouseEvent) => { e.stopPropagation(); handleToggleSsoSelfManage(org.id, !org.ssoSelfManage); }}
                >
                  <Shield class="w-3.5 h-3.5" />
                  SSO
                </Button>
                <div class="flex items-center gap-2">
                  <Users class="w-4 h-4 text-muted-foreground" />
                  <span class="text-sm text-muted-foreground">{org.memberCount} members</span>
                </div>
                <div class="flex items-center gap-2" title="{org.deploymentCount} deployments using {org.totalCapacity.toFixed(1)} GB">
                  <HardDrive class="w-4 h-4 text-muted-foreground" />
                  <span class="text-sm text-muted-foreground">{org.deploymentCount} deployments &middot; {org.totalCapacity.toFixed(1)} GB</span>
                </div>
                <span class="text-xs text-muted-foreground">
                  {new Date(org.createdAt).toLocaleDateString()}
                </span>
              </div>
            </div>

            {#if expandedOrg === org.id}
              <div class="border-t px-4 py-3">
                {#if loadingMembers.has(org.id)}
                  <p class="text-sm text-muted-foreground">Loading members...</p>
                {:else if orgMembers[org.id]?.length}
                  <table class="w-full text-sm">
                    <thead>
                      <tr class="border-b text-left">
                        <th class="py-2 pr-4 font-medium text-muted-foreground">Name</th>
                        <th class="py-2 pr-4 font-medium text-muted-foreground">Email</th>
                        <th class="py-2 pr-4 font-medium text-muted-foreground">Role</th>
                        <th class="py-2 pr-4 font-medium text-muted-foreground">Status</th>
                        <th class="py-2 font-medium text-muted-foreground">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each orgMembers[org.id] as member}
                        <tr class="border-b last:border-0">
                          <td class="py-2 pr-4">{member.userName}</td>
                          <td class="py-2 pr-4 text-muted-foreground">{member.userEmail}</td>
                          <td class="py-2 pr-4">
                            <select
                              class="rounded-md border border-input bg-background px-2 py-1 text-xs"
                              value={member.role}
                              onchange={(e) => handleRoleChange(member.userId, org.id, (e.target as HTMLSelectElement).value)}
                            >
                              {#each Object.entries(roleLabels) as [value, label]}
                                <option {value}>{label}</option>
                              {/each}
                            </select>
                          </td>
                          <td class="py-2 pr-4">
                            {#if member.userBanned}
                              <Badge variant="destructive">Banned</Badge>
                            {:else}
                              <Badge variant="outline">Active</Badge>
                            {/if}
                          </td>
                          <td class="py-2">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="Remove from organization"
                              onclick={() => handleRemoveMember(member.userId, org.id, member.userName)}
                            >
                              <X class="w-4 h-4" />
                            </Button>
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                {:else}
                  <p class="text-sm text-muted-foreground">No members in this organization.</p>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Pagination -->
      {#if totalPages > 1}
        <div class="flex items-center justify-between mt-4 pt-4 border-t">
          <span class="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages}
          </span>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage <= 1}
              onclick={() => goToPage(currentPage - 1)}
            >
              <ChevronLeft class="w-4 h-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages}
              onclick={() => goToPage(currentPage + 1)}
            >
              Next
              <ChevronRight class="w-4 h-4" />
            </Button>
          </div>
        </div>
      {/if}
    {/if}
  </Card.Content>
</Card.Root>
