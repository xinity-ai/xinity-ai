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
        {"role": "user", "content": "Write a short story about a robot."}
    ],
    temperature=0.7,
    max_tokens=500,
    stream=True  # Enable streaming
)

section = None

def enter_section(name):
    global section
    if section != name:
        separator = "\n\n" if section else ""
        print(f"{separator}[{name}]", flush=True)
        section = name

# Print tokens as they arrive
for chunk in response:
    if not chunk.choices:
        continue
    delta = chunk.choices[0].delta
    # Reasoning models stream their thinking separately from the answer
    reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
    if reasoning:
        enter_section("reasoning")
        print(reasoning, end="", flush=True)
    if delta.content:
        enter_section("answer")
        print(delta.content, end="", flush=True)
print()
