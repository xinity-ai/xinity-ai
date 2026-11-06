<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import { roleLabels, type RoleName } from "$lib/roles";

  let {
    value = $bindable(),
    roles = Object.keys(roleLabels) as RoleName[],
    onValueChange,
    disabled = false,
    inModal = false,
    id,
    class: triggerClass = "",
  }: {
    value: RoleName;
    roles?: RoleName[];
    onValueChange?: (role: RoleName) => void;
    disabled?: boolean;
    inModal?: boolean;
    id?: string;
    class?: string;
  } = $props();
</script>

<Select.Root type="single" bind:value={() => value, (role) => (value = role as RoleName)} {disabled} onValueChange={(role) => onValueChange?.(role as RoleName)}>
  <Select.Trigger {id} class={triggerClass}>
    {roleLabels[value] ?? value}
  </Select.Trigger>
  <Select.Content portalProps={{ disabled: inModal }}>
    {#each roles as role (role)}
      <Select.Item value={role} label={roleLabels[role]} />
    {/each}
  </Select.Content>
</Select.Root>
