curl {{API_BASE}}/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "'"$MODEL"'",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Tell a joke"}
    ],
    "temperature": 0.7,
    "max_tokens": 1500
  }'
