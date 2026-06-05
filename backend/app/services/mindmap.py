"""
Mind map generation service.
Asks the LLM to extract concepts + relationships from a PDF
and returns a graph structure for visualization.
"""

import json
from typing import Optional
from groq import Groq
from sqlalchemy.orm import Session
from app.config import settings
from app.models import Chunk


_groq = Groq(api_key=settings.GROQ_API_KEY)
LLM_MODEL = "llama-3.3-70b-versatile"


def _get_document_text(db: Session, document_id: str, max_chunks: int = 50) -> str:
    """Pull all chunks for a document, ordered by position."""
    chunks = (
        db.query(Chunk)
        .filter(Chunk.document_id == document_id)
        .order_by(Chunk.chunk_index)
        .limit(max_chunks)
        .all()
    )
    return "\n\n".join(
        f"[Page {c.page_number}]\n{c.content}" for c in chunks
    )


MINDMAP_SYSTEM = """You are an expert at extracting concept hierarchies from documents to create educational mind maps.

Given a document, identify:
1. ONE central topic (root node) — the overarching theme
2. 3-6 main branches — major themes/sections
3. 2-4 sub-concepts under each branch — specific ideas, requirements, components

Rules:
- Node labels: 2-6 words MAX, concise and specific
- Each node needs a brief description (1 sentence) for tooltip
- Include the page number where each concept appears
- Structure should be a tree (root → branches → leaves)

Return ONLY valid JSON in this exact shape — no commentary, no markdown fences:

{
  "title": "Document title",
  "nodes": [
    {"id": "root", "label": "Central Topic", "description": "...", "page": 1, "level": 0},
    {"id": "n1", "label": "Branch 1", "description": "...", "page": 1, "level": 1},
    {"id": "n1a", "label": "Sub-concept A", "description": "...", "page": 2, "level": 2}
  ],
  "edges": [
    {"source": "root", "target": "n1"},
    {"source": "n1", "target": "n1a"}
  ]
}

Generate 15-25 total nodes for a balanced, useful mind map."""


def _extract_json(text: str):
    """Strip markdown fences and parse JSON robustly."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    for i, ch in enumerate(text):
        if ch in "{[":
            text = text[i:]
            break
    return json.loads(text)


def generate_mindmap(db: Session, document_id: str) -> dict:
    """Generate a concept hierarchy from a document."""
    text = _get_document_text(db, document_id)
    if not text:
        raise ValueError("No content available")

    user_message = f"""Document content:

{text}

---
Generate a mind map following the rules above. Return only JSON."""

    response = _groq.chat.completions.create(
        model=LLM_MODEL,
        max_tokens=3000,
        temperature=0.4,
        messages=[
            {"role": "system", "content": MINDMAP_SYSTEM},
            {"role": "user", "content": user_message},
        ],
        response_format={"type": "json_object"},
    )

    raw = response.choices[0].message.content
    data = _extract_json(raw)

    # Validate basic shape
    if "nodes" not in data or "edges" not in data:
        raise ValueError(f"Invalid mind map structure: {data}")

    return data