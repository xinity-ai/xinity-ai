<script lang="ts">
  import type { PageData } from "./$types";
  import NoOrganization from "$lib/components/NoOrganization.svelte";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import { orpc } from "$lib/orpc/orpc-client";
  import { Cpu, Play, Square, Database, FileText, Activity, AlertCircle } from "@lucide/svelte";

  let { data }: { data: PageData } = $props();

  let datasets = $state(data.datasets);
  let jobs = $state(data.jobs || []);

  let baseModel = $state("unsloth/llama-3.1-8b-bnb-4bit");
  let learningRate = $state(0.0002);
  let epochs = $state(3);
  let loraRank = $state(16);
  let gpuId = $state("0");
  let isSubmitting = $state(false);
  let errorMessage = $state<string | null>(null);
  let selectedJobLogs = $state<string[]>([]);
  let activeLogJobId = $state<string | null>(null);

  async function handleStartJob() {
    isSubmitting = true;
    errorMessage = null;

    try {
      const [err, newJob] = await orpc.fineTuning.startJob({
        baseModel,
        learningRate,
        epochs,
        loraRank,
        gpuId
      });

      if (err) {
        errorMessage = err.message || "Failed to start fine-tuning job";
      } else if (newJob) {
        jobs = [newJob, ...jobs];
        selectedJobLogs = newJob.logs || [];
        activeLogJobId = newJob.jobId;
      }
    } catch (e: any) {
      errorMessage = e.message || "An unexpected error occurred";
    } finally {
      isSubmitting = false;
    }
  }

  async function handleCancelJob(jobId: string) {
    try {
      const [err, res] = await orpc.fineTuning.cancelJob({ jobId });
      if (!err && res?.success) {
        jobs = jobs.map(j => (j.jobId === jobId ? { ...j, status: "CANCELLED" } : j));
      }
    } catch (e: any) {
      console.error("Cancel job error", e);
    }
  }

  function viewLogs(job: any) {
    activeLogJobId = job.jobId;
    selectedJobLogs = job.logs || [];
  }
</script>

<svelte:head>
  <title>Fine-Tuning & Distillation | Xinity AI</title>
</svelte:head>

{#if !data.activeOrganizationId}
  <NoOrganization />
{:else}
  <div class="container px-4 py-8 compact:py-4 mx-auto">
    <div class="flex items-center justify-between mb-8 compact:mb-4">
      <div>
        <h1 class="text-3xl font-bold">Fine-Tuning & Distillation</h1>
        <p class="text-sm text-muted-foreground mt-1">
          Train custom On-Premise LoRA / QLoRA adapters from curated API call datasets.
        </p>
      </div>
      <Badge variant="outline" class="flex items-center gap-1.5 px-3 py-1">
        <Cpu class="w-4 h-4 text-primary" />
        <span>PyTorch & Unsloth Engine</span>
      </Badge>
    </div>

    {#if errorMessage}
      <div class="mb-6 p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-3 text-destructive text-sm">
        <AlertCircle class="w-5 h-5 flex-shrink-0" />
        <span>{errorMessage}</span>
      </div>
    {/if}

    <div class="grid grid-cols-1 gap-6 compact:gap-3 lg:grid-cols-3 mb-8">
      <!-- Dataset Stats Card -->
      <Card.Root>
        <Card.Header>
          <Card.Title class="flex items-center gap-2 text-lg">
            <Database class="w-5 h-5 text-primary" />
            <span>Dataset Overview</span>
          </Card.Title>
          <Card.Description>
            Filtered from active organization API call logs.
          </Card.Description>
        </Card.Header>
        <Card.Content class="space-y-4">
          <div class="flex justify-between items-center py-2 border-b">
            <span class="text-sm text-muted-foreground">Total API Calls</span>
            <span class="font-semibold">{datasets?.totalApiCalls ?? 0}</span>
          </div>
          <div class="flex justify-between items-center py-2 border-b">
            <span class="text-sm text-muted-foreground">Exportable ChatML Items</span>
            <span class="font-semibold text-primary">{datasets?.datasetItemCount ?? 0}</span>
          </div>
          <div>
            <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">
              JSONL Sample Preview
            </span>
            <pre class="p-3 bg-muted rounded-md text-xs font-mono overflow-x-auto max-h-36 text-muted-foreground">
              {datasets?.jsonlPreview || "No dataset items available yet. Make API calls to generate training samples."}
            </pre>
          </div>
        </Card.Content>
      </Card.Root>

      <!-- Training Job Configuration Form Card -->
      <Card.Root class="lg:col-span-2">
        <Card.Header>
          <Card.Title class="flex items-center gap-2 text-lg">
            <Play class="w-5 h-5 text-primary" />
            <span>Configure Training Run</span>
          </Card.Title>
          <Card.Description>
            Set base model and hyperparameters for LoRA fine-tuning.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <form onsubmit={(e) => { e.preventDefault(); handleStartJob(); }} class="space-y-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="space-y-2">
                <Label for="baseModel">Base Model</Label>
                <Input id="baseModel" bind:value={baseModel} placeholder="e.g. unsloth/llama-3.1-8b-bnb-4bit" required />
              </div>
              <div class="space-y-2">
                <Label for="gpuId">Target GPU ID</Label>
                <Input id="gpuId" bind:value={gpuId} placeholder="0" required />
              </div>
              <div class="space-y-2">
                <Label for="learningRate">Learning Rate</Label>
                <Input id="learningRate" type="number" step="0.00005" bind:value={learningRate} required />
              </div>
              <div class="space-y-2">
                <Label for="epochs">Epochs</Label>
                <Input id="epochs" type="number" min="1" max="50" bind:value={epochs} required />
              </div>
              <div class="space-y-2">
                <Label for="loraRank">LoRA Rank (r)</Label>
                <Input id="loraRank" type="number" min="4" max="128" bind:value={loraRank} required />
              </div>
            </div>

            <div class="pt-4 flex justify-end">
              <Button type="submit" disabled={isSubmitting || (datasets?.datasetItemCount ?? 0) === 0} class="flex items-center gap-2">
                <Play class="w-4 h-4" />
                <span>{isSubmitting ? "Starting..." : "Start Fine-Tuning Job"}</span>
              </Button>
            </div>
          </form>
        </Card.Content>
      </Card.Root>
    </div>

    <!-- Active & Past Training Jobs -->
    <Card.Root class="mb-8">
      <Card.Header>
        <Card.Title class="flex items-center gap-2 text-lg">
          <Activity class="w-5 h-5 text-primary" />
          <span>Training Jobs</span>
        </Card.Title>
        <Card.Description>
          Track active and past QLoRA fine-tuning runs.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if jobs.length === 0}
          <div class="py-8 text-center text-muted-foreground text-sm">
            No fine-tuning jobs launched yet. Select hyperparameters above to start your first job.
          </div>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-sm text-left">
              <thead class="text-xs uppercase bg-muted/50 text-muted-foreground border-b">
                <tr>
                  <th class="px-4 py-3">Job ID</th>
                  <th class="px-4 py-3">Base Model</th>
                  <th class="px-4 py-3">Status</th>
                  <th class="px-4 py-3">Epochs</th>
                  <th class="px-4 py-3">Current Loss</th>
                  <th class="px-4 py-3">Started At</th>
                  <th class="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {#each jobs as job (job.jobId)}
                  <tr class="border-b hover:bg-muted/30 transition-colors">
                    <td class="px-4 py-3 font-mono text-xs font-semibold">{job.jobId}</td>
                    <td class="px-4 py-3">{job.baseModel}</td>
                    <td class="px-4 py-3">
                      {#if job.status === "RUNNING"}
                        <Badge variant="default" class="bg-blue-600">RUNNING</Badge>
                      {:else if job.status === "COMPLETED"}
                        <Badge variant="default" class="bg-green-600">COMPLETED</Badge>
                      {:else if job.status === "FAILED"}
                        <Badge variant="destructive">FAILED</Badge>
                      {:else if job.status === "CANCELLED"}
                        <Badge variant="outline">CANCELLED</Badge>
                      {:else}
                        <Badge variant="secondary">QUEUED</Badge>
                      {/if}
                    </td>
                    <td class="px-4 py-3">{job.currentEpoch} / {job.totalEpochs}</td>
                    <td class="px-4 py-3 font-mono text-xs">{job.currentLoss ?? "N/A"}</td>
                    <td class="px-4 py-3 text-muted-foreground text-xs">{new Date(job.startedAt).toLocaleString()}</td>
                    <td class="px-4 py-3 text-right space-x-2">
                      <Button variant="outline" size="sm" onclick={() => viewLogs(job)} class="h-8 text-xs">
                        <FileText class="w-3.5 h-3.5 mr-1" /> Logs
                      </Button>
                      {#if job.status === "RUNNING"}
                        <Button variant="destructive" size="sm" onclick={() => handleCancelJob(job.jobId)} class="h-8 text-xs">
                          <Square class="w-3.5 h-3.5 mr-1" /> Cancel
                        </Button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </Card.Content>
    </Card.Root>

    <!-- Execution Logs Console -->
    {#if activeLogJobId}
      <Card.Root>
        <Card.Header>
          <Card.Title class="flex items-center gap-2 text-lg">
            <FileText class="w-5 h-5 text-primary" />
            <span>Execution Logs ({activeLogJobId})</span>
          </Card.Title>
        </Card.Header>
        <Card.Content>
          <pre class="p-4 bg-zinc-950 text-zinc-100 rounded-lg text-xs font-mono max-h-72 overflow-y-auto space-y-1">
            {#each selectedJobLogs as line}
              <div>{line}</div>
            {/each}
          </pre>
        </Card.Content>
      </Card.Root>
    {/if}
  </div>
{/if}
