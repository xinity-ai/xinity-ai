import { OpenAI } from "openai";

const openai = new OpenAI({
    baseURL: "{{API_BASE}}",
    apiKey: process.env.API_KEY,
});

// Conversation history
const messages = [
  { role: "system", content: "You are a helpful assistant." }
];

async function chat(userMessage) {
  messages.push({ role: "user", content: userMessage });

  const completion = await openai.chat.completions.create({
    model: process.env.MODEL,
    messages: messages,
    temperature: 0.7,
    max_tokens: 1500,
  });

  const assistantMessage = completion.choices[0].message.content;
  messages.push({ role: "assistant", content: assistantMessage });

  return assistantMessage;
}

// Example conversation
(async () => {
  console.log(await chat("What is the capital of France?"));
  console.log(await chat("What is its population?"));
})();
