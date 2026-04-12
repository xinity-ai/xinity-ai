import { OpenAI } from "openai";

const openai = new OpenAI({
    baseURL: "{{API_BASE}}",
    apiKey: process.env.API_KEY,
});

async function chatWithRetry(messages, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: process.env.MODEL,
        messages: messages,
        temperature: 0.7,
        max_tokens: 1500,
      });

      return completion.choices[0].message.content;

    } catch (error) {
      const status = error.response?.status;
      if (status === 429 || status === 503 || status === 504) {
        // 429: backend queue full, not a gateway rate limit
        // 503: backend unreachable (starting up or restarting)
        // 504: backend took too long to respond
        if (attempt < maxRetries - 1) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Service unavailable (${status}). Waiting ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          throw error;
        }
      } else {
        console.error("API error:", error.message);
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          throw error;
        }
      }
    }
  }
}

// Usage
chatWithRetry([
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Hello!" }
])
  .then(result => console.log(result))
  .catch(error => console.error("Failed after retries:", error));
