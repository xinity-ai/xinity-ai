<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { ChevronLeft, ChevronRight } from "@lucide/svelte";

  let {
    label,
    canPrev,
    canNext,
    onPrev,
    onNext,
  }: {
    label: string;
    canPrev: boolean;
    canNext: boolean;
    onPrev: () => void;
    onNext: () => void;
  } = $props();
</script>

<div class="flex items-center justify-between mt-4 pt-4 border-t">
  <span class="text-sm text-muted-foreground">{label}</span>
  <div class="flex items-center gap-2">
    <Button variant="outline" size="sm" disabled={!canPrev} onclick={onPrev}>
      <ChevronLeft class="w-4 h-4" />
      Previous
    </Button>
    <Button variant="outline" size="sm" disabled={!canNext} onclick={onNext}>
      Next
      <ChevronRight class="w-4 h-4" />
    </Button>
  </div>
</div>
