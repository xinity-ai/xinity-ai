import os
from openai import OpenAI

MODEL = "<your-model>"

client = OpenAI(
  api_key = os.getenv("API_KEY"),
  base_url = "{{API_BASE}}",
)

# Conversation history
messages = [
    {"role": "system", "content": "You are a helpful assistant."}
]

def chat(user_message):
    messages.append({"role": "user", "content": user_message})

    response = client.chat.completions.create(
        model=MODEL,
        messages=messages,
        temperature=0.7,
        max_tokens=1500
    )

    assistant_message = response.choices[0].message.content
    messages.append({"role": "assistant", "content": assistant_message})

    return assistant_message

# Example conversation
print(chat("What is the capital of France?"))
print(chat("What is its population?"))