import os
from openai import OpenAI

client = OpenAI(
  api_key=os.getenv("API_KEY"),
  base_url="{{API_BASE}}",
)

response = client.chat.completions.create(
    model=os.getenv("MODEL"),
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello! How are you?"}
    ],
    temperature=0.7,
    max_tokens=1500
)

print(response.choices[0].message.content)
