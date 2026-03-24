MODEL="<your-rerank-model>"

curl {{API_BASE}}/rerank \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "'$MODEL'",
    "query": "What is the capital of France?",
    "documents": [
      "Paris is the capital and most populous city of France.",
      "Berlin is the capital of Germany.",
      "France is a country in Western Europe.",
      "The Eiffel Tower is located in Paris."
    ],
    "top_n": 3,
    "return_documents": true
  }'
