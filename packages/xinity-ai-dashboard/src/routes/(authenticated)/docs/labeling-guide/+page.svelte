<script>
  import gettingStarted from './screenshots/0-getting-started.webp';
  import generalRating from './screenshots/1-general-rating.webp';
  import rateSections from './screenshots/2-rate-sections.webp';
  import editResponses from './screenshots/3-edit-responses.webp';
  import disableInputMessages from './screenshots/4-disable-input-messages.webp';
  import disableSelections from './screenshots/5-disable-selections.webp';
  import filterCalls from './screenshots/7-filter-calls.webp';
</script>

<svelte:head>
  <title>Labeling Guide - Documentation</title>
</svelte:head>

<div class="container px-4 py-8 mx-auto max-w-4xl">
  <nav class="mb-6">
    <a href="/docs/" class="text-blue-600 hover:text-blue-800 flex items-center gap-2">
      <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      All Docs
    </a>
  </nav>

  <h1 class="mb-4 text-4xl font-bold">Labeling Guide</h1>
  <p class="mb-8 text-lg text-gray-600">
    How to review, rate, and curate your training data. Good labeling is the single most impactful
    thing you can do to improve fine-tuned model quality.
  </p>

  <!-- Overview -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Overview</h2>
    <p class="text-gray-700 mb-4">
      Every API call that passes through Xinity AI is logged in the <strong>Data</strong> page, grouped by application.
      The labeling tools let you tell the system what "good" looks like, so future fine-tuning runs
      produce a model that matches your standards.
    </p>
    <p class="text-gray-700 mb-4">
      There are five labeling actions available to you:
    </p>
    <div class="overflow-x-auto">
      <table class="w-full text-sm border-collapse">
        <thead>
          <tr class="border-b text-left">
            <th class="py-2 pr-4 font-semibold">Action</th>
            <th class="py-2 pr-4 font-semibold">Where</th>
            <th class="py-2 font-semibold">Purpose</th>
          </tr>
        </thead>
        <tbody class="text-gray-700">
          <tr class="border-b">
            <td class="py-2 pr-4 font-medium">Like / Dislike</td>
            <td class="py-2 pr-4">Output</td>
            <td class="py-2">Rate the overall response quality</td>
          </tr>
          <tr class="border-b">
            <td class="py-2 pr-4 font-medium">Range highlight</td>
            <td class="py-2 pr-4">Output</td>
            <td class="py-2">Mark specific passages as good or bad</td>
          </tr>
          <tr class="border-b">
            <td class="py-2 pr-4 font-medium">Edit response</td>
            <td class="py-2 pr-4">Output</td>
            <td class="py-2">Provide the ideal response text</td>
          </tr>
          <tr class="border-b">
            <td class="py-2 pr-4 font-medium">Exclude message</td>
            <td class="py-2 pr-4">Input</td>
            <td class="py-2">Remove an entire input message from training</td>
          </tr>
          <tr>
            <td class="py-2 pr-4 font-medium">Exclude text range</td>
            <td class="py-2 pr-4">Input</td>
            <td class="py-2">Remove a specific passage within an input message</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- Getting started -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Getting Started</h2>
    <p class="text-gray-700 mb-4">
      Open the <strong>Data</strong> page from the sidebar and select an application. You will see a
      list of logged API calls on the left and a detail panel on the right.
    </p>
    <img
      src={gettingStarted}
      alt="Screenshot of the data page showing the call list on the left and the detail panel on the right, with an API call selected"
      class="rounded-lg border mb-4 w-full"
    />
    <p class="text-gray-700 mb-2">
      Click any call to expand it. The detail panel shows:
    </p>
    <ul class="list-disc list-inside text-gray-700 space-y-1">
      <li><strong>Input Messages</strong>: the conversation the model received</li>
      <li><strong>Output</strong>: what the model responded with</li>
      <li><strong>Call Details</strong>: metadata like model, duration, and API key</li>
    </ul>
  </section>

  <!-- Step 1: Overall rating -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-2">Step 1: Give an Overall Rating</h2>
    <p class="text-sm text-blue-700 bg-blue-50 rounded px-3 py-2 mb-4">
      <strong>Recommendation:</strong> Always start by giving every call a thumbs-up or thumbs-down.
      This is the single most valuable signal for fine-tuning, and it takes one click.
    </p>
    <p class="text-gray-700 mb-4">
      Below the output text you will find the <strong>thumbs-up</strong> and <strong>thumbs-down</strong> buttons.
      Click one to rate the overall response. Clicking the same button again clears the rating.
    </p>
    <img
      src={generalRating}
      alt="Screenshot of the rating controls below the output, showing the thumbs-up and thumbs-down buttons with the thumbs-up in its active green state"
      class="rounded-lg border mb-4 w-full"
    />
    <p class="text-gray-700">
      The overall rating sets the tone for the entire example. A liked response tells the training
      process "produce more like this." A disliked response tells it "avoid this." Even if you plan
      to make more detailed edits, always give an overall rating first.
    </p>
  </section>

  <!-- Step 2: Range highlighting -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Step 2: Highlight Good and Bad Passages</h2>
    <p class="text-gray-700 mb-4">
      For more fine-grained feedback, you can mark specific parts of the model's response as
      positive or negative.
    </p>
    <ol class="list-decimal list-inside text-gray-700 space-y-2 mb-4">
      <li>Switch to the <strong>Original</strong> tab above the output.</li>
      <li>Click and drag to select a passage of text.</li>
      <li>After a short delay a popup appears with a thumbs-up and thumbs-down button.</li>
      <li>Click one to apply the highlight. The text is colored green (positive) or red (negative).</li>
    </ol>
    <img
      src={rateSections}
      alt="Screenshot of the output text with a green positive highlight on one sentence and a red negative highlight on another, with the highlight popup visible"
      class="rounded-lg border mb-4 w-full"
    />
    <p class="text-gray-700 mb-2">
      To modify or remove a highlight, hover over it. A popup appears letting you change the
      rating or clear it entirely.
    </p>
    <h3 class="text-lg font-semibold mt-4 mb-2">When to use range highlighting</h3>
    <ul class="list-disc list-inside text-gray-700 space-y-1">
      <li>A response is mostly good but one paragraph is wrong: like the whole response, highlight the bad paragraph as negative.</li>
      <li>A response has a particularly strong explanation: highlight it as positive to reinforce that style.</li>
      <li>The model added unnecessary caveats or filler: highlight those as negative.</li>
    </ul>
  </section>

  <!-- Step 3: Editing -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Step 3: Edit the Response</h2>
    <p class="text-gray-700 mb-4">
      When a response needs more than a rating, you can rewrite it. The edited version becomes the
      "ideal response" that the model will learn from.
    </p>
    <ol class="list-decimal list-inside text-gray-700 space-y-2 mb-4">
      <li>Click <strong>Edit Response</strong> (top-right of the output area).</li>
      <li>Switch to the <strong>Edit</strong> tab. The full output text appears in an editable area.</li>
      <li>Make your changes. The editor auto-saves after 30 seconds of inactivity, or when you click away.</li>
      <li>A dot next to the Edit tab indicates unsaved changes; the label below confirms when the text differs from the original.</li>
    </ol>
    <img
      src={editResponses}
      alt="Screenshot of the edit tab open with modified text, showing the amber 'Edited from original' indicator and the Original and Edit tab buttons"
      class="rounded-lg border mb-4 w-full"
    />
    <p class="text-sm text-amber-700 bg-amber-50 rounded px-3 py-2 mb-4">
      <strong>Important:</strong> Editing resets the like/dislike rating for this call. Re-rate
      the response after editing to confirm your intent. <br>
      Range highlights are preserved, but only shown on the Original text tab. 
    </p>
    <h3 class="text-lg font-semibold mt-4 mb-2">Always edit disliked responses</h3>
    <p class="text-gray-700">
      A dislike alone tells the model what to avoid, but not what to do instead. Whenever you dislike
      a response and the alternative is not obvious, take the extra step to provide an edited version. Think of it as the answer you
      wish the model had given. This combination, "this was bad, here's what it should have
      been," is the most powerful training signal you can give.
    </p>
  </section>

  <!-- Step 4: Input exclusions -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Step 4: Curate the Input</h2>
    <p class="text-gray-700 mb-4">
      Sometimes the input messages contain content that should not be part of the training data.
      Xinity AI gives you two ways to exclude input content.
    </p>

    <h3 class="text-lg font-semibold mt-2 mb-2">Exclude an entire message</h3>
    <p class="text-gray-700 mb-4">
      Every input message has an <strong>eye icon</strong> in its top-right corner. Click it to
      toggle the message out of training. The message fades to indicate it is excluded. Click the
      icon again to include it.
    </p>
    <img
      src={disableInputMessages}
      alt="Screenshot of the input messages panel showing two normal messages and one grayed-out excluded message with a red eye-off icon in its corner"
      class="rounded-lg border mb-4 w-full"
    />

    <h3 class="text-lg font-semibold mt-4 mb-2">Exclude a text range</h3>
    <p class="text-gray-700 mb-4">
      For more precision, you can exclude specific passages within a message:
    </p>
    <ol class="list-decimal list-inside text-gray-700 space-y-2 mb-4">
      <li>Click and drag to select text within an input message.</li>
      <li>A popup appears with a red exclude icon.</li>
      <li>Click it. The selected text gets a red strikethrough to indicate it is excluded.</li>
    </ol>
    <img
      src={disableSelections}
      alt="Screenshot of an input message with a passage struck through in red, and the exclude popup visible above a text selection"
      class="rounded-lg border mb-4 w-full"
    />
    <p class="text-gray-700 mb-2">
      To undo, hover over the excluded passage and click the X button that appears.
    </p>
  </section>

  <!-- Use case: RAG -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Use Case: Labeling RAG Conversations</h2>
    <p class="text-gray-700 mb-4">
      Retrieval-Augmented Generation (RAG) pipelines inject retrieved context into the input
      messages, often as a system message or as part of the user message. When fine-tuning, you
      typically want the model to learn to answer <em>without</em> that injected context, so it can
      generate the knowledge on its own.
    </p>
    <h3 class="text-lg font-semibold mb-2">Recommended approach</h3>
    <ol class="list-decimal list-inside text-gray-700 space-y-2 mb-4">
      <li>
        <strong>Exclude the retrieval context.</strong> If the retrieved documents are in their own
        system message, exclude the entire message with the eye icon. If they are embedded inline
        in a user message, select the retrieval passage and use the text-range exclude.
      </li>
      <li>
        <strong>Rate the response.</strong> Judge the answer on its own merits. If it is correct and
        well-phrased, like it. If it parrots the context too literally, consider editing it into a
        more natural answer.
      </li>
      <li>
        <strong>Edit if needed.</strong> If the response only works because of the injected context,
        rewrite it so the answer stands on its own. This teaches the model to internalize the
        knowledge rather than relying on retrieval at inference time.
      </li>
    </ol>
    <!-- <img
      src={ragExample}
      alt="Screenshot showing a RAG conversation: a system message with retrieved documents is excluded (grayed out), the user question is kept, and the output is liked with an edit"
      class="rounded-lg border mb-4 w-full"
    /> -->
    <p class="text-gray-700">
      By excluding the retrieval context from training data, the fine-tuned model learns to produce
      the answer from its own weights rather than depending on a retrieval step.
    </p>
  </section>

  <!-- Use case: Multi-turn -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Use Case: Multi-Turn Conversations</h2>
    <p class="text-gray-700 mb-4">
      In multi-turn conversations, earlier exchanges provide context but may contain low-quality
      or irrelevant turns. Use input exclusions to clean these up:
    </p>
    <ul class="list-disc list-inside text-gray-700 space-y-2 mb-4">
      <li>
        <strong>Off-topic turns:</strong> If the user went off on a tangent mid-conversation and
        came back, exclude the off-topic messages so the model does not learn to mimic that
        pattern.
      </li>
      <li>
        <strong>Repeated instructions:</strong> If the same system prompt appears multiple times
        (e.g., from a stateless client resending context), exclude the duplicates.
      </li>
      <li>
        <strong>Sensitive data:</strong> If a message accidentally contains PII or internal data
        that should not be baked into model weights, exclude it or use the range exclude to
        redact the specific passage.
      </li>
    </ul>
  </section>

  <!-- Use case: Tool calls -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Use Case: Tool-Call Conversations</h2>
    <p class="text-gray-700 mb-4">
      When your application uses tool calls, the input messages often include tool results alongside
      user messages. The labeling approach depends on your goal:
    </p>
    <ul class="list-disc list-inside text-gray-700 space-y-2 mb-4">
      <li>
        <strong>Teaching the model to call tools:</strong> Keep the tool call and result messages
        in training. Like the response if the model chose the right tool. Dislike and edit if it
        should have called a different tool or used different arguments.
      </li>
      <li>
        <strong>Teaching the model to answer without tools:</strong> Exclude the tool-related
        messages and edit the response to be self-contained, similar to the RAG approach above.
      </li>
    </ul>
  </section>

  <!-- Workflow summary -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Recommended Workflow</h2>
    <p class="text-gray-700 mb-4">
      For efficient labeling sessions, work through calls in this order:
    </p>
    <ol class="list-decimal list-inside text-gray-700 space-y-3 mb-4">
      <li>
        <strong>Quick pass: rate everything.</strong> Go through the call list and give each response
        a thumbs-up or thumbs-down. Use the "no-reactions" filter to find unrated calls. This
        alone is a huge improvement to your training data.
      </li>
      <li>
        <strong>Edit the dislikes.</strong> Filter by "dislikes" and provide an edited ideal
        response for each. Remember: a dislike without an edit is a missed opportunity.
      </li>
      <li>
        <strong>Refine the inputs.</strong> For calls that will be used in fine-tuning, review
        the input messages and exclude anything that should not be learned (retrieval context,
        PII, noise). Use the range exclude for surgical precision.
      </li>
      <li>
        <strong>Highlight standout passages.</strong> For particularly good or bad responses, add
        range highlights to give the training process more detail about what works and what does
        not.
      </li>
    </ol>
    <img
      src={filterCalls}
      alt="Screenshot of the data page filtered by 'no-reactions', showing a list of unrated calls ready for a quick labeling pass"
      class="rounded-lg border mb-4 w-full"
    />
  </section>

  <!-- Tips -->
  <section class="mb-8 p-6 bg-white rounded-lg shadow-md">
    <h2 class="text-2xl font-semibold mb-4">Tips</h2>
    <ul class="list-disc list-inside text-gray-700 space-y-2">
      <li>Use the search and metadata filters to focus on specific types of calls.</li>
      <li>Labels are per-user. Multiple team members can label the same call independently, giving
        you consensus signals.</li>
      <li>When in doubt, like the response. A slightly-imperfect liked example is better than no
        signal at all.</li>
      <li>Short editing sessions spread over time produce better labels than marathon sessions where
        fatigue sets in.</li>
      <li>Use the <strong>Download JSON</strong> button to export a call with all its annotations for
        external tooling or review.</li>
    </ul>
  </section>

  <!-- Related docs -->
  <section class="p-6 bg-linear-to-r from-blue-50 to-indigo-50 rounded-lg">
    <h2 class="text-2xl font-semibold mb-4">Related Documentation</h2>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <a href="/docs/applications" class="block p-4 bg-white rounded-lg shadow-sm hover:shadow-md transition">
        <h3 class="font-semibold text-blue-600">Applications</h3>
        <p class="text-sm text-gray-600">Organize API calls into logical groups for labeling and fine-tuning.</p>
      </a>
      <a href="/docs/quick-start" class="block p-4 bg-white rounded-lg shadow-sm hover:shadow-md transition">
        <h3 class="font-semibold text-blue-600">Quick Start Guide</h3>
        <p class="text-sm text-gray-600">Deploy a model, create an API key, and make your first request.</p>
      </a>
      <a href="/docs/roles" class="block p-4 bg-white rounded-lg shadow-sm hover:shadow-md transition">
        <h3 class="font-semibold text-blue-600">Roles & Permissions</h3>
        <p class="text-sm text-gray-600">The "labeler" role can rate and annotate but cannot manage deployments.</p>
      </a>
      <a href="/docs/api-reference" class="block p-4 bg-white rounded-lg shadow-sm hover:shadow-md transition">
        <h3 class="font-semibold text-blue-600">API Reference</h3>
        <p class="text-sm text-gray-600">Endpoint details for calls that get logged and labeled.</p>
      </a>
    </div>
  </section>
</div>
