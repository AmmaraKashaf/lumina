"""
Learning service — generates summaries, quizzes, and flashcards from PDFs.
Uses Groq LLM, grounded in chunks retrieved from Qdrant.
"""

import json
from typing import List, Literal, Optional
from groq import Groq
from sqlalchemy.orm import Session
from app.config import settings
from app.models import Chunk


_groq = Groq(api_key=settings.GROQ_API_KEY)
LLM_MODEL = "llama-3.3-70b-versatile"


# ─── Helpers ──────────────────────────────────────────────────────────

def _get_document_text(db: Session, document_id: str, max_chunks: int = 50) -> str:
    """
    Pull document chunks from PostgreSQL and join them.
    For summaries/quizzes, we want a broad view of the doc, not vector search.
    """
    chunks = (
        db.query(Chunk)
        .filter(Chunk.document_id == document_id)
        .order_by(Chunk.chunk_index)
        .limit(max_chunks)
        .all()
    )

    return "\n\n".join(
        f"[Page {c.page_number}]\n{c.content}"
        for c in chunks
    )


def _extract_json(text: str) -> dict | list:
    """
    LLMs sometimes wrap JSON in ```json fences or add commentary.
    Extract the JSON portion robustly.
    """
    text = text.strip()

    # Strip markdown fences
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
        if text.endswith("```"):
            text = text[:-3].strip()

    # Find first { or [
    for i, ch in enumerate(text):
        if ch in "{[":
            text = text[i:]
            break

    return json.loads(text)


# ─── 1. SUMMARIES ──────────────────────────────────────────────────────

SummaryStyle = Literal["tldr", "executive", "detailed", "eli5"]

SUMMARY_PROMPTS = {
    "tldr": "Write a 2-3 sentence TL;DR of this document. Capture only the core point.",
    "executive": "Write an executive summary in 4-6 bullet points. Focus on key decisions, requirements, and outcomes.",
    "detailed": "Write a detailed summary covering all major sections. Use clear headings and paragraphs. ~300 words.",
    "eli5": "Explain this document like I'm five years old. Use simple words, analogies, and no jargon.",
}


def generate_summary(
    db: Session,
    document_id: str,
    style: SummaryStyle = "tldr",
) -> str:
    """Generate a summary in the requested style."""
    text = _get_document_text(db, document_id)
    if not text:
        return "No content available to summarize."

    prompt = SUMMARY_PROMPTS[style]
    user_message = f"""Here is the full document content:

{text}

---
Task: {prompt}

Important: Use ONLY the content above. Do not invent information."""

    response = _groq.chat.completions.create(
        model=LLM_MODEL,
        max_tokens=1024,
        temperature=0.4,
        messages=[
            {"role": "system", "content": "You are an expert summarizer who writes clearly and accurately."},
            {"role": "user", "content": user_message},
        ],
    )
    return response.choices[0].message.content.strip()


# ─── 2. QUIZ ───────────────────────────────────────────────────────────

QUIZ_SYSTEM = """You are an expert exam creator. Generate high-quality multiple choice questions from the provided document.

Rules:
- Each question must test understanding, not just memorization.
- Questions must be answerable ONLY from the document — no outside knowledge needed.
- 4 options per question, exactly ONE correct answer.
- Vary difficulty: mix easy recall, moderate application, and tricky distractor questions.
- Distractors (wrong answers) must be plausible — not obviously wrong.
- Include a brief explanation for each answer.

Return ONLY valid JSON in this exact shape — no commentary, no markdown fences:

{
  "questions": [
    {
      "question": "...",
      "options": ["A...", "B...", "C...", "D..."],
      "correct_index": 0,
      "explanation": "...",
      "page": 1
    }
  ]
}"""


def generate_quiz(
    db: Session,
    document_id: str,
    num_questions: int = 5,
) -> List[dict]:
    """Generate a multiple choice quiz."""
    text = _get_document_text(db, document_id)
    if not text:
        return []

    user_message = f"""Document content:

{text}

---
Generate exactly {num_questions} multiple choice questions following the rules above. Return only JSON."""

    response = _groq.chat.completions.create(
        model=LLM_MODEL,
        max_tokens=2048,
        temperature=0.5,
        messages=[
            {"role": "system", "content": QUIZ_SYSTEM},
            {"role": "user", "content": user_message},
        ],
        response_format={"type": "json_object"},
    )

    raw = response.choices[0].message.content
    parsed = _extract_json(raw)

    # Normalize shape — Groq sometimes returns just a list
    questions = parsed.get("questions", parsed) if isinstance(parsed, dict) else parsed
    return questions if isinstance(questions, list) else []


# ─── 3. FLASHCARDS ─────────────────────────────────────────────────────

FLASHCARD_SYSTEM = """You are an expert at creating study flashcards. Generate concise, high-quality flashcards from the provided document.

Rules:
- FRONT: a clear, specific question or term (not too broad)
- BACK: the answer — accurate, concise, complete enough to study from
- Cover diverse parts of the document, not just one section
- Avoid duplicates or near-duplicates

Return ONLY valid JSON in this exact shape — no commentary, no markdown fences:

{
  "flashcards": [
    {
      "front": "What is X?",
      "back": "X is...",
      "page": 1
    }
  ]
}"""


def generate_flashcards(
    db: Session,
    document_id: str,
    num_cards: int = 10,
) -> List[dict]:
    """Generate study flashcards."""
    text = _get_document_text(db, document_id)
    if not text:
        return []

    user_message = f"""Document content:

{text}

---
Generate exactly {num_cards} flashcards following the rules above. Return only JSON."""

    response = _groq.chat.completions.create(
        model=LLM_MODEL,
        max_tokens=2048,
        temperature=0.5,
        messages=[
            {"role": "system", "content": FLASHCARD_SYSTEM},
            {"role": "user", "content": user_message},
        ],
        response_format={"type": "json_object"},
    )

    raw = response.choices[0].message.content
    parsed = _extract_json(raw)

    cards = parsed.get("flashcards", parsed) if isinstance(parsed, dict) else parsed
    return cards if isinstance(cards, list) else []