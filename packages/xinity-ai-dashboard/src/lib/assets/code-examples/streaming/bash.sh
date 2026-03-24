MODEL="<your-model>"

curl {{API_BASE}}/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "'$MODEL'",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Write a short story about a robot."}
    ],
    "temperature": 0.7,
    "max_tokens": 500,
    "stream": true
  }'