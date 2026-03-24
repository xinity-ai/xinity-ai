<script lang="ts">
  import { humanDate } from "$lib/util";
  import type { Invitation } from "better-auth/plugins";

  // shadcn components
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";

  // Icons
  import { Mail } from "@lucide/svelte";

  let {
    invites,
  }: {
    invites: Invitation[];
  } = $props();
</script>

{#if invites.length}
  <section class="mt-8">
    <h2 class="text-xl font-semibold tracking-tight mb-4">Pending Invitations</h2>
    <div class="space-y-3">
      {#each invites as { email, id, status, expiresAt, role }}
        {@const acceptInviteLink = `/organizations/accept-invitation-${id}`}
        <Card.Root>
          <Card.Content class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 py-4">
            <div class="flex items-center gap-3">
              <div class="flex items-center justify-center w-10 h-10 rounded-full bg-muted">
                <Mail class="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p class="font-medium">{email}</p>
                <div class="flex flex-wrap items-center gap-2 mt-1 text-sm text-muted-foreground">
                  <Badge variant="outline">{role}</Badge>
                  <span>Expires {humanDate(expiresAt)}</span>
                  <Badge variant="secondary" class="capitalize">{status}</Badge>
                </div>
              </div>
            </div>
            <Button href={acceptInviteLink} data-sveltekit-preload-data="off">
              Accept Invitation
            </Button>
          </Card.Content>
        </Card.Root>
      {/each}
    </div>
  </section>
{/if}
