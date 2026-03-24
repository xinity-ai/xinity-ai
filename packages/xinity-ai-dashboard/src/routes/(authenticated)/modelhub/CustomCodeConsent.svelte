<script lang="ts">
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Label } from "$lib/components/ui/label";
  import { ShieldAlert } from "@lucide/svelte";

  let {
    consented = $bindable(false),
    idSuffix = "",
  }: {
    consented: boolean;
    idSuffix?: string;
  } = $props();
</script>

<div class="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
  <ShieldAlert class="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
  <div class="space-y-3">
    <div>
      <p class="font-medium text-amber-700 dark:text-amber-300">Custom Code Execution Required</p>
      <p class="text-sm text-amber-600 dark:text-amber-400 mt-1">
        This model requires executing custom code from the model repository during inference.
        The vLLM instance will be started with <code class="bg-amber-200/50 dark:bg-amber-800/50 px-1 rounded">--trust-remote-code</code>.
        Ensure you trust the model source before proceeding.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <Checkbox
        id="custom-code-consent{idSuffix}"
        checked={consented}
        onCheckedChange={(checked) => consented = checked === true}
      />
      <Label for="custom-code-consent{idSuffix}" class="text-sm text-amber-700 dark:text-amber-300 cursor-pointer">
        I understand and accept the risks of running custom code
      </Label>
    </div>
  </div>
</div>
