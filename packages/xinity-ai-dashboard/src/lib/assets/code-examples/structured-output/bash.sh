MODEL="<your-model>"

curl {{API_BASE}}/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "'$MODEL'",
    "messages": [
      {"role": "system", "content": "Extract structured data from the text."},
      {"role": "user", "content": "John Smith is 32 years old and works as a software engineer at Acme Corp in Berlin."}
    ],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "person_info",
        "strict": true,
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
          "additionalProperties": false
        }
      }
    }
  }'