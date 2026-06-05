"""
Qdrant vector store service.
Stores chunk embeddings and provides semantic search.
"""

from typing import List, Optional
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    VectorParams,
    PointStruct,
    Filter,
    FieldCondition,
    MatchValue,
)
from app.config import settings
from app.services.embeddings import EMBEDDING_DIM


COLLECTION_NAME = "lumina_chunks"

_client = QdrantClient(
    url=settings.QDRANT_URL,
    api_key=settings.QDRANT_API_KEY,
    timeout=30,
)


def ensure_collection():
    """Create the chunks collection + payload indexes if not exists."""
    collections = _client.get_collections().collections
    names = [c.name for c in collections]

    if COLLECTION_NAME not in names:
        _client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=VectorParams(
                size=EMBEDDING_DIM,
                distance=Distance.COSINE,
            ),
        )
        print(f"✅ Created Qdrant collection '{COLLECTION_NAME}'")

    # Ensure payload indexes exist (idempotent — safe to call repeatedly)
    # Required so we can filter by document_id when searching/deleting
    try:
        _client.create_payload_index(
            collection_name=COLLECTION_NAME,
            field_name="document_id",
            field_schema="keyword",
        )
        print("✅ Created payload index on 'document_id'")
    except Exception:
        # Index already exists — that's fine
        pass


def upsert_chunks(chunks: List[dict]) -> int:
    """
    Insert or update chunks in Qdrant.

    Each chunk dict must contain:
        - id (str): chunk UUID
        - vector (List[float]): the embedding
        - payload (dict): metadata (document_id, content, page, etc.)

    Returns: number of points upserted.
    """
    points = [
        PointStruct(
            id=chunk["id"],
            vector=chunk["vector"],
            payload=chunk["payload"],
        )
        for chunk in chunks
    ]
    _client.upsert(collection_name=COLLECTION_NAME, points=points, wait=True)
    return len(points)


def search_similar(
    query_vector: List[float],
    limit: int = 5,
    document_id: Optional[str] = None,
) -> List[dict]:
    """
    Find chunks most similar to the query vector.

    Args:
        query_vector: embedding of the user's question
        limit: max results to return
        document_id: optional filter to search only within one document

    Returns: list of {"id", "score", "payload"} dicts.
    """
    # Build optional filter
    qdrant_filter = None
    if document_id:
        qdrant_filter = Filter(
            must=[FieldCondition(
                key="document_id",
                match=MatchValue(value=document_id),
            )]
        )

    results = _client.search(
        collection_name=COLLECTION_NAME,
        query_vector=query_vector,
        limit=limit,
        query_filter=qdrant_filter,
    )

    return [
        {
            "id": str(point.id),
            "score": point.score,
            "payload": point.payload,
        }
        for point in results
    ]


def delete_chunks_for_document(document_id: str):
    """Remove all Qdrant points belonging to a document."""
    _client.delete(
        collection_name=COLLECTION_NAME,
        points_selector=Filter(
            must=[FieldCondition(
                key="document_id",
                match=MatchValue(value=document_id),
            )]
        ),
    )