import os
import json
from openai import OpenAI

client = OpenAI(
  api_key=os.getenv("API_KEY"),
  base_url="{{API_BASE}}",
)

# Define available tools
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "City name, e.g. 'London'"
                    },
                    "unit": {
                        "type": "string",
                        "enum": ["celsius", "fahrenheit"],
                        "description": "Temperature unit"
                    }
                },
                "required": ["location"]
            }
        }
    }
]

# First request: let the model decide whether to call a tool
response = client.chat.completions.create(
    model=os.getenv("MODEL"),
    messages=[
        {"role": "user", "content": "What's the weather like in Berlin?"}
    ],
    tools=tools,
    tool_choice="auto"
)

message = response.choices[0].message

# Check if the model wants to call a tool
if message.tool_calls:
    tool_call = message.tool_calls[0]
    args = json.loads(tool_call.function.arguments)
    print(f"Tool call: {tool_call.function.name}({args})")

    # Call your function and return the result
    tool_result = json.dumps({"temperature": 18, "unit": "celsius", "condition": "cloudy"})

    # Second request: send the tool result back
    follow_up = client.chat.completions.create(
        model=os.getenv("MODEL"),
        messages=[
            {"role": "user", "content": "What's the weather like in Berlin?"},
            message,
            {
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": tool_result
            }
        ],
        tools=tools
    )
    print(follow_up.choices[0].message.content)
else:
    print(message.content)
