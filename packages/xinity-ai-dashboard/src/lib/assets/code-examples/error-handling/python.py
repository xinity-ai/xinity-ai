import os
import time
from openai import OpenAI
from openai.error import RateLimitError, APIError

MODEL = "<your-model>"

client = OpenAI(
  api_key = os.getenv("API_KEY"),
  base_url = "{{API_BASE}}",
)

def chat_with_retry(messages, max_retries=3):
    for attempt in range(max_retries):
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                temperature=0.7,
                max_tokens=1500
            )
            return response.choices[0].message.content

        except RateLimitError:
            if attempt < max_retries - 1:
                wait_time = 2 ** attempt
                print(f"Rate limit hit. Waiting {wait_time}s...")
                time.sleep(wait_time)
            else:
                raise

        except APIError as e:
            print(f"API error: {e}")
            if attempt < max_retries - 1:
                time.sleep(1)
            else:
                raise

# Usage
try:
    result = chat_with_retry([
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"}
    ])
    print(result)
except Exception as e:
    print(f"Failed after retries: {e}")