"""
RAG (Retrieval-Augmented Generation) service.
Vector search + Groq LLM + conversation memory + streaming.
"""

from typing import List, Optional, Iterator, Dict
from groq import Groq
from app.config import settings
from app.services.embeddings import embed_text
from app.services.vector_store import search_similar


_groq = Groq(api_key=settings.GROQ_API_KEY)

LLM_MODEL = "llama-3.3-70b-versatile"

# Limit how much history to send (cost + speed)
MAX_HISTORY_MESSAGES = 10


SYSTEM_PROMPT = """You are Lumina, an AI study companion that helps users understand their documents.

You will be given excerpts from a document along with the user's question, and the prior conversation. Your job is to answer the question using ONLY the information in the provided excerpts.

Rules:
- Answer in clear, natural language.
- Cite the page number when you reference specific information, like this: [page 2].
- If the excerpts don't contain the answer, say "I couldn't find that in the document" — do NOT make things up.
- Keep answers focused and direct. No filler.
- For follow-up questions, use the prior conversation for context (pronouns like "it", "that", "they" refer to earlier topics).
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


def _build_messages(
    question: str,
    context: str,
    history: Optional[List[Dict]] = None,
) -> List[Dict]:
    """
    Build the message list to send to Groq:
    [system] [...history] [current user message with retrieved context]
    """
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Include trimmed conversation history
    if history:
        recent = history[-MAX_HISTORY_MESSAGES:]
        for msg in recent:
            messages.append({
                "role": msg["role"],
                "content": msg["content"],
            })

    # Current user message includes the retrieved context
    user_content = f"""Here are relevant excerpts from the document:

{context}

---
User's question: {question}

Answer using only the excerpts above. Use the prior conversation for context if needed."""

    messages.append({"role": "user", "content": user_content})
    return messages


def retrieve_chunks(
    question: str,
    document_id: Optional[str] = None,
    top_k: int = 5,
) -> List[dict]:
    """Embed the question and retrieve top-k similar chunks."""
    query_vector = embed_text(question)
    return search_similar(
        query_vector=query_vector,
        limit=top_k,
        document_id=document_id,
    )


def answer_question(
    question: str,
    document_id: Optional[str] = None,
    history: Optional[List[Dict]] = None,
    top_k: int = 5,
) -> dict:
    """
    Non-streaming RAG: returns full answer at once.
    """
    chunks = retrieve_chunks(question, document_id, top_k)

    if not chunks:
        return {
            "answer": "I couldn't find any relevant content in the document to answer that.",
            "sources": [],
        }

    context = build_context(chunks)
    messages = _build_messages(question, context, history)

    response = _groq.chat.completions.create(
        model=LLM_MODEL,
        max_tokens=1024,
        temperature=0.3,
        messages=messages,
    )

    return {
        "answer": response.choices[0].message.content,
        "sources": [
            {
                "page": c["payload"].get("page_number"),
                "content": c["payload"].get("content"),
                "score": c["score"],
            }
            for c in chunks
        ],
    }


def answer_question_stream(
    question: str,
    document_id: Optional[str] = None,
    history: Optional[List[Dict]] = None,
    top_k: int = 5,
) -> Iterator[Dict]:
    """
    Streaming RAG: yields events as the answer is generated.

    Yields dicts with shape:
        {"type": "sources", "data": [...]}     — sent once at start
        {"type": "token", "data": "word"}      — many of these
        {"type": "done", "data": null}         — final marker
    """
    chunks = retrieve_chunks(question, document_id, top_k)

    # Send sources first so the UI can show citations immediately
    sources = [
        {
            "page": c["payload"].get("page_number"),
            "content": c["payload"].get("content"),
            "score": c["score"],
        }
        for c in chunks
    ]
    yield {"type": "sources", "data": sources}

    if not chunks:
        yield {"type": "token", "data": "I couldn't find any relevant content in the document to answer that."}
        yield {"type": "done", "data": None}
        return

    context = build_context(chunks)
    messages = _build_messages(question, context, history)

    # Stream tokens from Groq
    stream = _groq.chat.completions.create(
        model=LLM_MODEL,
        max_tokens=1024,
        temperature=0.3,
        messages=messages,
        stream=True,
    )

    for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            yield {"type": "token", "data": delta}

    yield {"type": "done", "data": None}