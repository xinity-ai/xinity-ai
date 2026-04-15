import { OpenAI } from "openai";

const openai = new OpenAI({
    baseURL: "{{API_BASE}}",
    apiKey: process.env.API_KEY,
});

async function chat() {
  const completion = await openai.chat.completions.create({
    model: process.env.MODEL,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello! How are you?" }
    ],
    temperature: 0.7,
    max_tokens: 1500,
  });

  console.log(completion.choices[0].message.content);
}

chat();
