import { OpenAI } from "openai";

const MODEL = "<your-model>";

const openai = new OpenAI({
    baseURL: "{{API_BASE}}",
    apiKey: process.env.API_KEY,
});

// Define available tools
const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "City name, e.g. 'London'",
          },
          unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "Temperature unit",
          },
        },
        required: ["location"],
      },
    },
  },
];

async function main() {
  // First request: let the model decide whether to call a tool
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "user", content: "What's the weather like in Berlin?" }
    ],
    tools,
    tool_choice: "auto",
  });

  const message = response.choices[0].message;

  // Check if the model wants to call a tool
  if (message.tool_calls) {
    const toolCall = message.tool_calls[0];
    const args = JSON.parse(toolCall.function.arguments);
    console.log(`Tool call: ${toolCall.function.name}(${JSON.stringify(args)})`);

    // Call your function and return the result
    const toolResult = JSON.stringify({
      temperature: 18, unit: "celsius", condition: "cloudy"
    });

    // Second request: send the tool result back
    const followUp = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "user", content: "What's the weather like in Berlin?" },
        message,
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        },
      ],
      tools,
    });
    console.log(followUp.choices[0].message.content);
  } else {
    console.log(message.content);
  }
}

main();