import os
import time
from openai import OpenAI
from openai.error import RateLimitError, APIError

client = OpenAI(
  api_key=os.getenv("API_KEY"),
  base_url="{{API_BASE}}",
)

def chat_with_retry(messages, max_retries=3):
    for attempt in range(max_retries):
        try:
            response = client.chat.completions.create(
                model=os.getenv("MODEL"),
                messages=messages,
                temperature=0.7,
                max_tokens=1500
            )
            return response.choices[0].message.content

        except RateLimitError:  # 429: backend queue full, not a gateway rate limit
            if attempt < max_retries - 1:
                wait_time = 2 ** attempt
                print(f"Backend overloaded (429). Waiting {wait_time}s...")
                time.sleep(wait_time)
            else:
                raise

        except APIError as e:
            status = getattr(e, 'http_status', 0)
            if status in (503, 504) and attempt < max_retries - 1:
                # 503: backend unreachable (starting up or restarting)
                # 504: backend took too long to respond
                wait_time = 2 ** attempt
                print(f"Service degraded ({status}). Waiting {wait_time}s...")
                time.sleep(wait_time)
            elif attempt < max_retries - 1:
                print(f"API error: {e}")
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
