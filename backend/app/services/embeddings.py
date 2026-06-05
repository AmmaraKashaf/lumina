"""
Local embedding service using sentence-transformers.
Runs the model directly on this machine — no API calls, no internet needed.
"""

from typing import List
from sentence_transformers import SentenceTransformer


# Same model as before, just running locally
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIM = 384

print(f"⏳ Loading embedding model '{EMBEDDING_MODEL}' (first run downloads ~80 MB)...")
_model = SentenceTransformer(EMBEDDING_MODEL)
print("✅ Embedding model loaded")


def embed_text(text: str) -> List[float]:
    """
    Convert a single piece of text into a 384-dim vector.
    """
    vector = _model.encode(text, convert_to_numpy=True, show_progress_bar=False)
    return vector.tolist()


def embed_batch(texts: List[str]) -> List[List[float]]:
    """
    Embed many texts at once — way faster than one-by-one.
    """
    vectors = _model.encode(
        texts,
        convert_to_numpy=True,
        show_progress_bar=False,
        batch_size=32,
    )
    return [v.tolist() for v in vectors]