<script lang="ts">
  import { toastState } from "$lib/state/toast.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { ChevronDown, ChevronRight, Loader2 } from "@lucide/svelte";

  export type ComplianceFramework = "GDPR" | "EU AI Act" | "NIS2";

  export type PostureCheckView = {
    id: string;
    kind: "automated" | "organizational";
    frameworks: ComplianceFramework[];
    evidenceIds: string[];
    articleRef: string;
    title: string;
    explanation: string;
    status: "pass" | "warn" | "fail";
    detail: string;
    artifact?: {
      id: string;
      fileName: string;
      size: number;
      note: string | null;
      reviewBy: string | null;
      updatedAt: string | Date;
    } | null;
  };

  const {
    check,
    canManage,
    onChanged,
  }: { check: PostureCheckView; canManage: boolean; onChanged: () => void } = $props();

  let expanded = $state(false);
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  let reviewBy = $state("");

  const statusDot: Record<PostureCheckView["status"], string> = {
    pass: "bg-green-500",
    warn: "bg-amber-500",
    fail: "bg-red-500",
  };
  const statusLabel: Record<PostureCheckView["status"], string> = {
    pass: "Evidence complete",
    warn: "Needs attention",
    fail: "Gap",
  };

  const frameworkStyle: Record<ComplianceFramework, string> = {
    "GDPR": "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
    "EU AI Act": "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800",
    "NIS2": "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-800",
  };

  async function upload() {
    const file = fileInput?.files?.[0];
    if (!file) {
      toastState.add("Choose a file first", "error");
      return;
    }
    uploading = true;
    const form = new FormData();
    form.set("file", file);
    form.set("kind", check.id);
    if (reviewBy) form.set("reviewBy", reviewBy);
    const res = await fetch("/compliance/artifact", { method: "POST", body: form });
    if (res.ok) {
      toastState.add("Document uploaded", "success");
      if (fileInput) fileInput.value = "";
      onChanged();
    } else {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      toastState.add(body?.message ?? "Upload failed", "error");
    }
    uploading = false;
  }

  async function removeArtifact() {
    if (!check.artifact) return;
    const res = await fetch(`/compliance/artifact/${check.artifact.id}`, { method: "DELETE" });
    if (res.ok) {
      toastState.add("Document removed", "success");
      onChanged();
    } else {
      toastState.add("Failed to remove document", "error");
    }
  }
</script>

<div class="border-b last:border-0 py-2">
  <button
    type="button"
    class="flex w-full items-center gap-3 text-left"
    onclick={() => (expanded = !expanded)}
  >
    {#if expanded}
      <ChevronDown class="w-4 h-4 shrink-0 text-muted-foreground" />
    {:else}
      <ChevronRight class="w-4 h-4 shrink-0 text-muted-foreground" />
    {/if}
    <span class={`w-2.5 h-2.5 rounded-full shrink-0 ${statusDot[check.status]}`}></span>
    <span class="flex-1 text-sm font-medium">{check.title}</span>
    <span class="hidden sm:flex gap-1">
      {#each check.frameworks as framework (framework)}
        <span class={`rounded-full border px-2 py-0.5 text-[0.65rem] font-medium whitespace-nowrap ${frameworkStyle[framework]}`}>
          {framework}
        </span>
      {/each}
    </span>
    <Badge variant={check.status === "fail" ? "destructive" : check.status === "warn" ? "outline" : "secondary"}>
      {statusLabel[check.status]}
    </Badge>
  </button>

  {#if expanded}
    <div class="ml-9 mt-2 space-y-2 text-sm">
      <p class="text-muted-foreground">{check.explanation}</p>
      <p>
        <span class="font-medium">Status:</span>
        {check.detail}
      </p>
      <p class="text-xs text-muted-foreground">
        {check.articleRef} · Evidence {check.evidenceIds.join(", ")} (see the Xinity compliance guide)
      </p>

      {#if check.kind === "organizational"}
        {#if check.artifact}
          <div class="flex flex-wrap items-center gap-3">
            <a class="underline" href={`/compliance/artifact/${check.artifact.id}`}>
              {check.artifact.fileName}
            </a>
            <span class="text-xs text-muted-foreground">
              {(check.artifact.size / 1024).toFixed(0)} KB
              {#if check.artifact.reviewBy}
                · review by {check.artifact.reviewBy}
              {/if}
            </span>
            {#if canManage}
              <Button variant="outline" size="sm" onclick={removeArtifact}>Remove</Button>
            {/if}
          </div>
        {/if}
        {#if canManage}
          <div class="flex flex-wrap items-end gap-3">
            <div class="space-y-1">
              <Label for={`file-${check.id}`}>{check.artifact ? "Replace document" : "Upload document"}</Label>
              <input
                id={`file-${check.id}`}
                type="file"
                bind:this={fileInput}
                class="block text-sm file:mr-3 file:rounded-md file:border file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
              />
            </div>
            <div class="space-y-1">
              <Label for={`review-${check.id}`}>Review by (optional)</Label>
              <Input id={`review-${check.id}`} type="date" class="w-40" bind:value={reviewBy} />
            </div>
            <Button size="sm" disabled={uploading} onclick={upload}>
              {#if uploading}
                <Loader2 class="w-4 h-4 animate-spin" /> Uploading...
              {:else}
                Upload
              {/if}
            </Button>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
