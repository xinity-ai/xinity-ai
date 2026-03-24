const MODEL = "<your-rerank-model>";
const API_BASE = "{{API_BASE}}";

async function rerank() {
  const response = await fetch(`${API_BASE}/rerank`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      query: "What is the capital of France?",
      documents: [
        "Paris is the capital and most populous city of France.",
        "Berlin is the capital of Germany.",
        "France is a country in Western Europe.",
        "The Eiffel Tower is located in Paris.",
      ],
      top_n: 3,
      return_documents: true,
    }),
  });

  const data = await response.json();

  for (const result of data.results) {
    const score = result.relevance_score.toFixed(4);
    const doc = result.document.text;
    console.log(`[${score}] ${doc}`);
  }
}

rerank();
