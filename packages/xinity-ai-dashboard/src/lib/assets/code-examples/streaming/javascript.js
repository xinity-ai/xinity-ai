import { OpenAI } from "openai";

const openai = new OpenAI({
    baseURL: "{{API_BASE}}",
    apiKey: process.env.API_KEY,
});

async function streamChat() {
  const response = await openai.chat.completions.create({
    model: process.env.MODEL,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Write a short story about a robot." }
    ],
    temperature: 0.7,
    max_tokens: 500,
    stream: true,
  });

  let section = null;
  const enterSection = (name) => {
    if (section !== name) {
      process.stdout.write(`${section ? "\n\n" : ""}[${name}]\n`);
      section = name;
    }
  };

  for await (const chunk of response) {
    const delta = chunk.choices[0]?.delta;
    // Reasoning models stream their thinking separately from the answer
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (reasoning) {
      enterSection("reasoning");
      process.stdout.write(reasoning);
    }
    if (delta?.content) {
      enterSection("answer");
      process.stdout.write(delta.content);
    }
  }
  process.stdout.write("\n");
}

streamChat();
