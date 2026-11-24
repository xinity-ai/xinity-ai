<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { humanDateTime } from "$lib/util";
  import { DEFAULT_ROLLOUT_HOURS, MAX_ROLLOUT_HOURS, MIN_ROLLOUT_HOURS, endOfDraft, type AdvanceDraft } from "$lib/components/deployments/rollout-advance";

  let { advance = $bindable(), invalid = $bindable(false), idSuffix = "" }: { advance: AdvanceDraft; invalid?: boolean; idSuffix?: string } = $props();

  const CHOICES: { initial: AdvanceDraft; label: string; hint: string }[] = [
    { initial: { type: "manual" }, label: "By hand", hint: "Traffic moves only when you set it." },
    { initial: { type: "time", hours: DEFAULT_ROLLOUT_HOURS }, label: "Over time", hint: "Traffic moves evenly to 100% over the hours you give." },
  ];

  const hoursError = $derived(
    advance.type === "time" && !(Number.isInteger(advance.hours) && advance.hours >= MIN_ROLLOUT_HOURS && advance.hours <= MAX_ROLLOUT_HOURS)
      ? `Give a whole number of hours from ${MIN_ROLLOUT_HOURS} to ${MAX_ROLLOUT_HOURS}.`
      : null,
  );

  $effect(() => {
    invalid = Boolean(hoursError);
  });
</script>

<div class="space-y-2">
  <div class="grid gap-2 sm:grid-cols-2" role="radiogroup">
    {#each CHOICES as choice (choice.initial.type)}
      <label class="flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-primary/5">
        <span class="flex items-center gap-2 font-medium">
          <input
            type="radio"
            name="advance{idSuffix}"
            checked={advance.type === choice.initial.type}
            onchange={() => (advance = { ...choice.initial })}
          />
          {choice.label}
        </span>
        <span class="text-xs text-muted-foreground">{choice.hint}</span>
      </label>
    {/each}
  </div>
  {#if advance.type === "time"}
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <label for="rollout-hours{idSuffix}">Reach 100% in</label>
      <Input id="rollout-hours{idSuffix}" type="number" min={MIN_ROLLOUT_HOURS} max={MAX_ROLLOUT_HOURS} step="1" bind:value={advance.hours} class="h-8 w-24" aria-invalid={Boolean(hoursError)} aria-describedby="rollout-hours-end{idSuffix}" />
      <span>hours</span>
      {#if !hoursError}
        <span id="rollout-hours-end{idSuffix}" class="text-xs text-muted-foreground">(at {humanDateTime(endOfDraft(advance))})</span>
      {/if}
    </div>
    {#if hoursError}
      <p id="rollout-hours-end{idSuffix}" class="text-xs text-destructive">{hoursError}</p>
    {/if}
  {/if}
</div>
