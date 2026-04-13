import os
import requests

API_KEY = os.getenv("API_KEY")

response = requests.post(
    "{{API_BASE}}/rerank",
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    },
    json={
        "model": os.getenv("MODEL"),
        "query": "What is the capital of France?",
        "documents": [
            "Paris is the capital and most populous city of France.",
            "Berlin is the capital of Germany.",
            "France is a country in Western Europe.",
            "The Eiffel Tower is located in Paris.",
        ],
        "top_n": 3,
        "return_documents": True,
    },
)

data = response.json()

for result in data["results"]:
    score = result["relevance_score"]
    doc = result["document"]["text"]
    print(f"[{score:.4f}] {doc}")
