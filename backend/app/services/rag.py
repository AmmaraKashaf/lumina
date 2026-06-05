"""
RAG (Retrieval-Augmented Generation) service.
Vector search + Groq LLM → answers grounded in PDF content.
"""

from typing import List, Optional
from groq import Groq
from app.config import settings
from app.services.embeddings import embed_text
from app.services.vector_store import search_similar


_groq = Groq(api_key=settings.GROQ_API_KEY)

# Llama 3.3 70B — best free model on Groq for RAG
LLM_MODEL = "llama-3.3-70b-versatile"


SYSTEM_PROMPT = """You are Lumina, an AI study companion that helps users understand their documents.

You will be given excerpts from a document along with the user's question. Your job is to answer the question using ONLY the information in the provided excerpts.

Rules:
- Answer in clear, natural language.
- Cite the page number when you reference specific information, like this: [page 2].
- If the excerpts don't contain the answer, say "I couldn't find that in the document" — do NOT make things up.
- Keep answers focused and direct. No filler.
- If the question is conversational (like "hi"), respond naturally without forcing citations."""


def build_context(chunks: List[dict]) -> str:
    """Format retrieved chunks into a context block for the LLM."""
    parts = []
    for i, chunk in enumerate(chunks, 1):
        payload = chunk["payload"]
        page = payload.get("page_number", "?")
        content = payload.get("content", "")
        parts.append(f"[Excerpt {i} — page {page}]\n{content}")
    return "\n\n".join(parts)


def answer_question(
    question: str,
    document_id: Optional[str] = None,
    top_k: int = 5,
) -> dict:
    """
    Full RAG pipeline:
    1. Embed the question
    2. Retrieve top_k similar chunks from Qdrant
    3. Send chunks + question to Groq Llama
    4. Return answer with sources
    """
    # 1. Embed the question
    query_vector = embed_text(question)

    # 2. Retrieve relevant chunks
    chunks = search_similar(
        query_vector=query_vector,
        limit=top_k,
        document_id=document_id,
    )

    if not chunks:
        return {
            "answer": "I couldn't find any relevant content in the document to answer that.",
            "sources": [],
        }

    # 3. Build context + ask LLM
    context = build_context(chunks)

    user_message = f"""Here are relevant excerpts from the document:

{context}

---
User's question: {question}

Answer using only the excerpts above."""

    response = _groq.chat.completions.create(
        model=LLM_MODEL,
        max_tokens=1024,
        temperature=0.3,  # lower = more focused/factual
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
    )

    answer = response.choices[0].message.content

    return {
        "answer": answer,
        "sources": [
            {
                "page": c["payload"].get("page_number"),
                "content": c["payload"].get("content"),
                "score": c["score"],
            }
            for c in chunks
        ],
    }