import os
import json
from openai import OpenAI

client = OpenAI(
  api_key=os.getenv("API_KEY"),
  base_url="{{API_BASE}}",
)

response = client.chat.completions.create(
    model=os.getenv("MODEL"),
    messages=[
        {"role": "system", "content": "Extract structured data from the text."},
        {"role": "user", "content": "John Smith is 32 years old and works as a software engineer at Acme Corp in Berlin."}
    ],
    response_format={
        "type": "json_schema",
        "json_schema": {
            "name": "person_info",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "age": {"type": "integer"},
                    "job_title": {"type": "string"},
                    "company": {"type": "string"},
                    "city": {"type": "string"}
                },
                "required": ["name", "age", "job_title", "company", "city"],
                "additionalProperties": False
            }
        }
    }
)

data = json.loads(response.choices[0].message.content)
print(json.dumps(data, indent=2))
