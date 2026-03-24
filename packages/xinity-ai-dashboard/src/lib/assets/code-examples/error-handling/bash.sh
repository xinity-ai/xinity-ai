#!/bin/bash

MODEL="<your-model>"
MAX_RETRIES=3
RETRY_DELAY=1

for i in $(seq 1 $MAX_RETRIES); do
  response=$(curl -s -w "\n%{http_code}" {{API_BASE}}/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d '{
      "model": "'$MODEL'",
      "messages": [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"}
      ]
    }')

  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | head -n-1)

  if [ "$http_code" -eq 200 ]; then
    echo "$body"
    exit 0
  elif [ "$http_code" -eq 429 ]; then
    echo "Rate limit hit. Retrying in ${RETRY_DELAY}s..."
    sleep $RETRY_DELAY
    RETRY_DELAY=$((RETRY_DELAY * 2))
  else
    echo "Error $http_code: $body"
    exit 1
  fi
done

echo "Failed after $MAX_RETRIES retries"
exit 1