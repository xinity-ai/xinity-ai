import { OpenAI } from "openai";

const MODEL = "<your-model>";

const openai = new OpenAI({
    baseURL: "{{API_BASE}}",
    apiKey: process.env.API_KEY,
});

async function extractPerson() {
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: "Extract structured data from the text." },
      { role: "user", content: "John Smith is 32 years old and works as a software engineer at Acme Corp in Berlin." }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "person_info",
        strict: true,
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "integer" },
            job_title: { type: "string" },
            company: { type: "string" },
            city: { type: "string" },
          },
          required: ["name", "age", "job_title", "company", "city"],
          additionalProperties: false,
        },
      },
    },
  });

  const data = JSON.parse(response.choices[0].message.content);
  console.log(JSON.stringify(data, null, 2));
}

extractPerson();