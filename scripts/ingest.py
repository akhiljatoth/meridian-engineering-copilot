import os
import re
import hashlib
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from qdrant_client import QdrantClient, models

load_dotenv()

DATA_DIR = Path("/app/data")
COLLECTION = os.getenv("COLLECTION_NAME", "meridian_docs")
EMBED_MODEL = "gemini-embedding-001"
CHUNK_SIZE = 1800
CHUNK_OVERLAP = 200
VECTOR_SIZE = 3072


def chunk_text(text: str) -> list[str]:
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    chunks = []
    start = 0

    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        chunk = text[start:end].strip()

        if chunk:
            chunks.append(chunk)

        if end == len(text):
            break

        start = end - CHUNK_OVERLAP

    return chunks


def embed_text(client: genai.Client, text: str) -> list[float]:
    response = client.models.embed_content(
        model=EMBED_MODEL,
        contents=text,
        config={"task_type": "RETRIEVAL_DOCUMENT"},
    )
    return response.embeddings[0].values


def main():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("Set GEMINI_API_KEY in .env before ingestion.")

    google_client = genai.Client(api_key=api_key)
    qdrant = QdrantClient(url=os.getenv("QDRANT_URL", "http://localhost:6333"))

    if qdrant.collection_exists(COLLECTION):
        qdrant.delete_collection(COLLECTION)

    qdrant.create_collection(
        collection_name=COLLECTION,
        vectors_config=models.VectorParams(
            size=VECTOR_SIZE,
            distance=models.Distance.COSINE,
        ),
    )

    points = []
    total_chunks = 0

    for path in sorted(DATA_DIR.rglob("*.md")):
        relative = path.relative_to(DATA_DIR)
        role = relative.parts[0] if len(relative.parts) > 1 else "engineer"
        if role not in {"engineer", "admin"}:
            role = "engineer"

        text = path.read_text(encoding="utf-8")
        title_match = re.search(r"(?m)^#\s+(.+)$", text)
        title = title_match.group(1).strip() if title_match else path.stem.replace("-", " ").title()

        for index, chunk in enumerate(chunk_text(text)):
            vector = embed_text(google_client, chunk)
            point_id = hashlib.md5(
                f"{relative}:{index}".encode()
            ).hexdigest()

            points.append(
                models.PointStruct(
                    id=point_id,
                    vector=vector,
                    payload={
                        "text": chunk,
                        "source": relative.as_posix(),
                        "title": title,
                        "role": role,
                        "chunk_index": index,
                    },
                )
            )
            total_chunks += 1

            if len(points) >= 20:
                qdrant.upsert(collection_name=COLLECTION, points=points)
                points.clear()

    if points:
        qdrant.upsert(collection_name=COLLECTION, points=points)

    print(f"Ingestion complete: {total_chunks} chunks stored in '{COLLECTION}'.")


if __name__ == "__main__":
    main()