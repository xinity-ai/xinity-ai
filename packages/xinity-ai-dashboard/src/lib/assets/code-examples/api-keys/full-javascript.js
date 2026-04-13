import { OpenAI } from "openai";

const openai = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: "{{API_BASE}}",
});

async function createChatCompletion() {
  const completion = await openai.chat.completions.create({
    model: process.env.MODEL,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Tell a joke" }
    ],
    temperature: 0.7,
    max_tokens: 1500,
  });

  console.log(completion.choices[0].message.content);
}

createChatCompletion();
