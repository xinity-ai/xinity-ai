import os
from openai import OpenAI

MODEL = "<your-model>"

client = OpenAI(
  api_key = os.getenv("API_KEY"),
  base_url = "{{API_BASE}}",
)

response = client.chat.completions.create(
    model=MODEL,
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Write a short story about a robot."}
    ],
    temperature=0.7,
    max_tokens=500,
    stream=True  # Enable streaming
)

# Print tokens as they arrive
for chunk in response:
    if chunk.choices[0].delta.get("content"):
        print(chunk.choices[0].delta.content, end="", flush=True)