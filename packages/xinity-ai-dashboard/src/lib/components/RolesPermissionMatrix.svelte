<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { Separator } from "$lib/components/ui/separator";
  import { roles, roleLabels, roleBadgeVariant, type RoleName } from "$lib/roles";

  type ResourcePermissions = {
    label: string;
    actions: Record<RoleName, string[]>;
  };

  const permissionObjects = {
    "apiKey": "AI API Keys",
    "apiCall": "API Calls",
    "apiCallResponse": "Response Ratings",
    "modelDeployment": "Model Deployments",
    "model": "Custom Models",
    "aiApplication": "Applications",
    "organization": "Organization Settings",
    "member": "Members & Invitations",
  }

  const resources: ResourcePermissions[] = Object.entries(permissionObjects).map(([object, label]) => ({
    label,
    actions: Object.fromEntries(Object.entries(roles).map(([role, values]) =>
      [role, values.statements[object as keyof typeof values.statements] as string[]] as [RoleName, string[]]
    )) as Record<RoleName, string[]>,
  }))

  const roleOrder: RoleName[] = Object.keys(roleLabels) as RoleName[];

  const roleDescriptions: Record<RoleName, string> = {
    owner: "Full control over the organization, its members, and all resources.",
    admin: "Can manage members and all resources, but cannot delete the organization or transfer ownership.",
    member: "Can work with models, deployments, API keys, and applications.",
    labeler: "Can rate and label API call responses. Read-only access to models and applications.",
    viewer: "Read-only access to API calls, models, deployments, and applications.",
    pending: "Can sign in and manage their own account. No access to organization resources.",
  };

  function formatActions(actions: string[]): string {
    if (actions.length === 0) return "\u2014";
    return actions.join(", ");
  }
</script>

<div class="space-y-6">
  <div class="grid gap-3">
    {#each roleOrder as role}
      <div class="flex items-start gap-3">
        <Badge variant={roleBadgeVariant[role]} class="mt-0.5 shrink-0">
          {roleLabels[role]}
        </Badge>
        <p class="text-sm text-muted-foreground">{roleDescriptions[role]}</p>
      </div>
    {/each}
  </div>

  <Separator />

  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b">
          <th class="text-left py-2 pr-4 font-medium text-muted-foreground">Resource</th>
          {#each roleOrder as role}
            <th class="text-center py-2 px-2 font-medium text-muted-foreground">{roleLabels[role]}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each resources as resource}
          <tr class="border-b last:border-0">
            <td class="py-2.5 pr-4 font-medium">{resource.label}</td>
            {#each roleOrder as role}
              <td class="text-center py-2.5 px-2 text-xs text-muted-foreground">
                {formatActions(resource.actions[role] || [])}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
