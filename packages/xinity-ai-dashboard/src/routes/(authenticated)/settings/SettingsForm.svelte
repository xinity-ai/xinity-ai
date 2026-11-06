<script lang="ts">
  import type { Snippet } from "svelte";
  import type { User } from "common-db";
  import { orpc } from "$lib/orpc/orpc-client";
  import { pick } from "$lib/util";
  import { toastState } from "$lib/state/toast.svelte";
  import PendingButton from "$lib/components/PendingButton.svelte";
  import { Separator } from "$lib/components/ui/separator";

  type SettingsField = keyof NonNullable<Parameters<typeof orpc.user.updateSettings>[0]> & keyof User;

  let {
    title,
    description,
    user,
    fields,
    onSaved,
    children,
  }: {
    title: string;
    description: string;
    user: User;
    fields: SettingsField[];
    onSaved?: () => Promise<void>;
    children: Snippet<[User]>;
  } = $props();

  // svelte-ignore state_referenced_locally
  let settings = $state<User>(structuredClone(user));
  let isSaving = $state(false);

  $effect(() => {
    settings = structuredClone(user);
  });

  async function save() {
    isSaving = true;
    const [error] = await orpc.user.updateSettings(pick(settings, ...fields));
    if (error) {
      toastState.add(error.message, "error");
    } else {
      toastState.add("Settings saved successfully", "success");
      await onSaved?.();
    }
    isSaving = false;
  }
</script>

<div class="space-y-6">
  <div>
    <h2 class="text-lg font-semibold tracking-tight">{title}</h2>
    <p class="text-sm text-muted-foreground">{description}</p>
  </div>

  <Separator />

  <div class="space-y-4">
    {@render children(settings)}
  </div>

  <Separator />

  <div class="flex gap-3">
    <PendingButton onclick={save} pending={isSaving} pendingLabel="Saving...">
      Save Settings
    </PendingButton>
  </div>
</div>
