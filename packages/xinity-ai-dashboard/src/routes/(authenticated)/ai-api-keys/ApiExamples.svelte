<script lang="ts">
  import { getClientEnv } from "$lib/clientEnv";
  import CodeExample from "$lib/components/CodeExample.svelte";
  import { getApiKeyExamples } from "$lib/assets/code-examples/loader";

  // shadcn components
  import * as Card from "$lib/components/ui/card";
  import { Separator } from "$lib/components/ui/separator";

  const { GATEWAY_URL } = getClientEnv();
  const apiBase = `${GATEWAY_URL}/v1`;

  const examples = getApiKeyExamples(apiBase);

  type Language = "python" | "javascript" | "bash";
  type Section = { heading: string; code: string; language: Language };
  type Tab = { id: Language; label: string; sections: Section[] };

  const tabs: Tab[] = [
    {
      id: "python",
      label: "Python",
      sections: [
        { heading: "API Base URL", code: examples["base-url-python"], language: "python" },
        { heading: "Complete Example", code: examples["full-python"], language: "python" },
      ],
    },
    {
      id: "javascript",
      label: "JavaScript",
      sections: [
        { heading: "API Base URL", code: examples["base-url-javascript"], language: "javascript" },
        { heading: "Complete Example", code: examples["full-javascript"], language: "javascript" },
      ],
    },
    {
      id: "bash",
      label: "cURL",
      sections: [
        { heading: "Complete Example", code: examples["full-bash"], language: "bash" },
      ],
    },
  ];

  let selectedTab: Language = $state("python");
  const activeSections = $derived(tabs.find((t) => t.id === selectedTab)?.sections ?? []);
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
            onclick={() => (selectedTab = tab.id)}
          >
            {tab.label}
          </button>
        {/each}
      </div>
    </div>

    <!-- Tab Content -->
    <div class="space-y-6">
      {#each activeSections as section, i (section.heading)}
        {#if i > 0}<Separator />{/if}
        <div>
          <h3 class="text-base font-medium mb-2">{section.heading}</h3>
          <CodeExample code={section.code} language={section.language} withCopy />
        </div>
      {/each}
    </div>
  </Card.Content>
</Card.Root>
