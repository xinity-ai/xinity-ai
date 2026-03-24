<script lang="ts">
  import { clientEnv } from "$lib/clientEnv";
  import CodeExample from "$lib/components/CodeExample.svelte";
  import { getApiKeyExamples } from "$lib/assets/code-examples/loader";

  // shadcn components
  import * as Card from "$lib/components/ui/card";
  import { Separator } from "$lib/components/ui/separator";

  const apiBase = clientEnv.PUBLIC_LLM_API_URL.endsWith("/v1")
    ? clientEnv.PUBLIC_LLM_API_URL
    : `${clientEnv.PUBLIC_LLM_API_URL}/v1`;

  const examples = getApiKeyExamples(apiBase);

  let selectedTab = $state("python");

  const tabs = [
    { id: "python", label: "Python" },
    { id: "javascript", label: "JavaScript" },
    { id: "bash", label: "cURL" },
  ];

  function handleTabChange(tab: string) {
    selectedTab = tab;
  }
</script>

<Card.Root class="lg:col-span-3">
  <Card.Header>
    <Card.Title>API Usage Examples</Card.Title>
    <Card.Description>
      Use our API with your preferred programming language.
    </Card.Description>
  </Card.Header>
  <Card.Content>
    <!-- Language Tabs -->
    <div class="mb-4 border-b">
      <div class="flex gap-4 -mb-px">
        {#each tabs as tab}
          <button
            class="pb-3 text-sm font-medium border-b-2 transition-colors {selectedTab ===
            tab.id
              ? 'text-primary border-primary'
              : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border'}"
            onclick={() => handleTabChange(tab.id)}
          >
            {tab.label}
          </button>
        {/each}
      </div>
    </div>

    <!-- Tab Content -->
    <div class="space-y-6">
      {#if selectedTab === "python"}
        <div class="space-y-6">
          <div>
            <h3 class="text-base font-medium mb-2">API Base URL</h3>
            <CodeExample
              code={examples["base-url-python"]}
              language="python"
              withCopy
            />
          </div>
          <Separator />
          <div>
            <h3 class="text-base font-medium mb-2">Complete Example</h3>
            <CodeExample
              code={examples["full-python"]}
              language="python"
              withCopy
            />
          </div>
        </div>
      {:else if selectedTab === "javascript"}
        <div class="space-y-6">
          <div>
            <h3 class="text-base font-medium mb-2">API Base URL</h3>
            <CodeExample
              code={examples["base-url-javascript"]}
              language="javascript"
              withCopy
            />
          </div>
          <Separator />
          <div>
            <h3 class="text-base font-medium mb-2">Complete Example</h3>
            <CodeExample
              code={examples["full-javascript"]}
              language="javascript"
              withCopy
            />
          </div>
        </div>
      {:else if selectedTab === "bash"}
        <div class="space-y-6">
          <div>
            <h3 class="text-base font-medium mb-2">Complete Example</h3>
            <CodeExample
              code={examples["full-bash"]}
              language="bash"
              withCopy
            />
          </div>
        </div>
      {/if}
    </div>
  </Card.Content>
</Card.Root>
