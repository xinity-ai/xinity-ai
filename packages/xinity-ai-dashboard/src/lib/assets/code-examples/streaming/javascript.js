import { OpenAI } from "openai";

const MODEL = "<your-model>";

const openai = new OpenAI({
    baseURL: "{{API_BASE}}",
    apiKey: process.env.API_KEY,
});

async function streamChat() {
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Write a short story about a robot." }
    ],
    temperature: 0.7,
    max_tokens: 500,
    stream: true,
  });

  for await(let chunk of response){
    if(chunk.choices[0]?.delta?.content){
      process.stdout.write(chunk.choices[0].delta.content);
    }
  }
}

streamChat();