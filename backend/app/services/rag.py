"""
RAG (Retrieval-Augmented Generation) service with smart question routing.

3 retrieval modes:
- Overview:        "what chapters are in this book"   → broad sample
- Specific section: "what is chapter 3"               → vector search + keyword boost
- Default:         "what is gradient descent"         → vector search
"""

import re
from typing import List, Optional, Iterator, Dict
from groq import Groq
from sqlalchemy.orm import Session
from app.config import settings
from app.services.embeddings import embed_text
from app.services.vector_store import search_similar
from app.models import Chunk


_groq = Groq(api_key=settings.GROQ_API_KEY)
LLM_MODEL = "llama-3.3-70b-versatile"
MAX_HISTORY_MESSAGES = 10


SYSTEM_PROMPT = """You are Lumina, an AI study companion that helps users understand their documents.

You will be given relevant sections from a document along with the user's question and prior conversation. Answer using ONLY the information in those sections.

Rules:
- Answer in clear, natural language. Never use words like "excerpt", "passage", or "chunk" in your response.
- Cite the page number when referencing specific information, like this: [page 2].
- If the document sections don't contain the answer, say so honestly — do NOT make things up.
- Keep answers focused and direct. No filler.
- For follow-up questions, use the prior conversation for context (pronouns like "it", "that", "they" refer to earlier topics).
- If the question is conversational (like "hi"), respond naturally without forcing citations."""


# ─── Question routing ─────────────────────────────────────────────────

OVERVIEW_PATTERNS = [
    # Anything mentioning chapters in a general way
    r"\bchapters?\b.*\b(this|the|of)\b",
    r"\b(what|which|list|name|tell me)\b.*\bchapters?\b",
    r"\bchapter (names?|list|titles?)\b",
    r"\btable of contents\b",
    r"\btoc\b",
    # Outlines & structure
    r"\b(give me|show me|list|provide)( an?| the)? outline\b",
    r"\b(give me|show me|what(s)? the)\b.*\bstructure\b",
    r"\bsections?\b.*\bof (this|the)\b",
    # General "about" questions
    r"\bwhat (is|are) (this|the) (book|document|pdf|paper|text) about\b",
    r"\bwhat does (this|the) (book|document|pdf|paper) cover\b",
    r"\b(give|provide) (an?|the) (overview|summary)\b",
    r"\bsummari[sz]e\b.*\b(book|document|pdf|paper|whole)\b",
    r"\boverview of (this|the)\b",
    r"\bmain (points?|ideas?|themes?|topics?)\b",
    # Page count and metadata
    r"\bhow many (pages|chapters|sections)\b",
    r"\btotal (pages|chapters|sections)\b",
]

# Detects mentions of a specific section/chapter by number or name
SPECIFIC_SECTION_PATTERNS = [
    r"\bchapter\s+\d+\b",
    r"\bchapter\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b",
    r"\bsection\s+\d+",
    r"\bpart\s+\d+",
    r"\bappendix\s+[a-z\d]",
    r"\bpage\s+\d+",
    r'"[^"]{5,}"',   # quoted chapter/section name e.g. "Uncommon Amongst Uncommon"
    r"'[^']{5,}'",   # single-quoted variant
    r"\b(executive\s+summary|introduction|conclusion|abstract|foreword|preface|acknowledgements?|bibliography|references|glossary)\b",
]

NAMED_SECTIONS = [
    "executive summary", "introduction", "conclusion", "abstract",
    "foreword", "preface", "acknowledgements", "acknowledgement",
    "bibliography", "references", "glossary",
]


def is_overview_question(question: str) -> bool:
    q = question.lower()
    # If they mention a specific chapter/section, it's NOT overview
    if any(re.search(pat, q) for pat in SPECIFIC_SECTION_PATTERNS):
        return False
    return any(re.search(pat, q) for pat in OVERVIEW_PATTERNS)


def is_specific_section_question(question: str) -> bool:
    q = question.lower()
    return any(re.search(pat, q) for pat in SPECIFIC_SECTION_PATTERNS)


def extract_section_keywords(question: str) -> List[str]:
    """
    Extract section identifiers to look for in chunks.
    Covers many real-world chapter formatting styles.
    E.g. "What is Chapter 3?" → [
        "chapter 3", "chapter three", "ch 3", "ch. 3",
        "chapter iii", "3.", "3:", "3 ", ...
    ]
    """
    q = question.lower()
    keywords = []

    word_to_num = {
        "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
        "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
        "eleven": "11", "twelve": "12",
    }
    num_to_word = {v: k for k, v in word_to_num.items()}

    num_to_roman = {
        "1": "i", "2": "ii", "3": "iii", "4": "iv", "5": "v",
        "6": "vi", "7": "vii", "8": "viii", "9": "ix", "10": "x",
        "11": "xi", "12": "xii",
    }

    # "chapter N" (digit)
    for match in re.finditer(r"\bchapter\s+(\d+)\b", q):
        n = match.group(1)
        word = num_to_word.get(n)
        roman = num_to_roman.get(n)
        # Cover many formatting variants real books use
        keywords.extend([
            f"chapter {n}",          # "Chapter 3"
            f"chapter {n}.",         # "Chapter 3."
            f"chapter {n}:",         # "Chapter 3:"
            f"ch {n}",
            f"ch. {n}",
            f"ch.{n}",
            f"\n{n}.",               # body: "3. THE TITLE"
            f"\n{n}:",               # body: "3: THE TITLE"
        ])
        if word:
            keywords.extend([
                f"chapter {word}",   # "Chapter Three"
            ])
        if roman:
            keywords.extend([
                f"chapter {roman}",  # "Chapter III"
            ])

    # "chapter one/two/..."
    for match in re.finditer(r"\bchapter\s+(\w+)\b", q):
        word = match.group(1).lower()
        if word in word_to_num:
            n = word_to_num[word]
            roman = num_to_roman.get(n)
            keywords.extend([
                f"chapter {n}",
                f"chapter {word}",
                f"\n{n}.",
                f"\n{n}:",
            ])
            if roman:
                keywords.append(f"chapter {roman}")

    # "section N", "part N", "appendix N"
    for prefix in ["section", "part", "appendix"]:
        for match in re.finditer(rf"\b{prefix}\s+(\w+)\b", q):
            keywords.append(f"{prefix} {match.group(1)}")

    # Quoted chapter/section names e.g. "Uncommon Amongst Uncommon"
    for match in re.finditer(r'"([^"]{5,})"', q):
        keywords.append(match.group(1).strip())
    for match in re.finditer(r"'([^']{5,})'", q):
        keywords.append(match.group(1).strip())

    # Named sections: executive summary, introduction, conclusion, etc.
    for section in NAMED_SECTIONS:
        if section in q:
            keywords.append(section)

    # Deduplicate while preserving order
    seen = set()
    result = []
    for kw in keywords:
        if kw not in seen:
            seen.add(kw)
            result.append(kw)
    return result


# ─── Context builders ─────────────────────────────────────────────────

def build_context_from_chunks(chunks: List[dict]) -> str:
    """Format chunks (with payload-style dicts) into a context block."""
    parts = []
    for i, chunk in enumerate(chunks, 1):
        payload = chunk["payload"]
        page = payload.get("page_number", "?")
        content = payload.get("content", "")
        parts.append(f"[Page {page}]\n{content}")
    return "\n\n".join(parts)


def build_overview_context(
    db: Session,
    document_id: str,
    max_chars: int = 25000,
) -> tuple[str, List[dict]]:
    """For overview questions: structured sample across the whole document."""
    all_chunks = (
        db.query(Chunk)
        .filter(Chunk.document_id == document_id)
        .order_by(Chunk.chunk_index)
        .all()
    )

    if not all_chunks:
        return "", []

    n = len(all_chunks)
    if n <= 30:
        sampled = all_chunks
    else:
        intro_cutoff = max(10, n // 7)
        sampled_indices = set(range(intro_cutoff))
        remaining = n - intro_cutoff
        step = max(1, remaining // 20)
        for i in range(intro_cutoff, n, step):
            sampled_indices.add(i)
        sampled = [all_chunks[i] for i in sorted(sampled_indices)]

    parts, sources, current_chars = [], [], 0
    for chunk in sampled:
        block = f"[Page {chunk.page_number}]\n{chunk.content}"
        if current_chars + len(block) > max_chars:
            break
        parts.append(block)
        sources.append({
            "page": chunk.page_number,
            "content": chunk.content,
            "score": 1.0,
        })
        current_chars += len(block)

    return "\n\n".join(parts), sources


def build_section_context(
    db: Session,
    document_id: str,
    question: str,
    keywords: List[str],
    max_chars: int = 25000,
) -> tuple[str, List[dict]]:
    """
    For specific-section questions: combine vector search with keyword matching.
    Strategy:
      1. Find chunks containing the section keyword (e.g. "Chapter 3") via SQL.
      2. Grab a window of surrounding chunks (the section is sequential).
      3. Add top vector-search hits for the same question.
    """
    all_chunks = (
        db.query(Chunk)
        .filter(Chunk.document_id == document_id)
        .order_by(Chunk.chunk_index)
        .all()
    )

    if not all_chunks:
        return "", []

    # ── 1. Find anchor chunks containing the keyword
    keyword_hits: List[int] = []
    for idx, chunk in enumerate(all_chunks):
        content_lower = (chunk.content or "").lower()
        if any(kw in content_lower for kw in keywords):
            keyword_hits.append(idx)

    selected_indices: set[int] = set()

    # ── 2. For each hit, include a window of surrounding chunks
    WINDOW = 15  # 15 chunks before + after the anchor (~12,000 chars window)
    for hit_idx in keyword_hits:
        for j in range(max(0, hit_idx - 2), min(len(all_chunks), hit_idx + WINDOW)):
            selected_indices.add(j)

    # ── 3. Augment with vector search for the question
    query_vector = embed_text(question)
    vector_results = search_similar(
        query_vector=query_vector,
        limit=10,
        document_id=document_id,
    )
    # Match vector hits back to chunk indices
    for vr in vector_results:
        chunk_id = vr["id"]
        for idx, chunk in enumerate(all_chunks):
            if str(chunk.id) == chunk_id:
                selected_indices.add(idx)
                break

    # If nothing matched (no keyword hits AND no vector hits — unlikely), fall back
    if not selected_indices:
        return "", []

    # Build context in document order
    parts, sources, current_chars = [], [], 0
    for idx in sorted(selected_indices):
        chunk = all_chunks[idx]
        block = f"[Page {chunk.page_number}]\n{chunk.content}"
        if current_chars + len(block) > max_chars:
            break
        parts.append(block)
        sources.append({
            "page": chunk.page_number,
            "content": chunk.content,
            "score": 1.0 if idx in {i for i in keyword_hits} else 0.7,
        })
        current_chars += len(block)

    return "\n\n".join(parts), sources


# ─── Message builder ──────────────────────────────────────────────────

def _build_messages(
    question: str,
    context: str,
    history: Optional[List[Dict]] = None,
) -> List[Dict]:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    if history:
        for msg in history[-MAX_HISTORY_MESSAGES:]:
            messages.append({"role": msg["role"], "content": msg["content"]})

    user_content = f"""Here are relevant sections from the document:

{context}

---
User's question: {question}

Answer using only the document sections above. Use the prior conversation for context if needed."""

    messages.append({"role": "user", "content": user_content})
    return messages


# ─── Retrieval router ─────────────────────────────────────────────────

def retrieve_for_question(
    db: Session,
    question: str,
    document_id: Optional[str] = None,
    top_k: int = 5,
) -> tuple[List[dict], str]:
    """Smart retrieval: routes based on question type."""

    # Special case: page count / chunk count metadata
    if document_id and re.search(r"\b(how many|total|number of) pages\b", question.lower()):
        count_result = db.query(Chunk.page_number).filter(
            Chunk.document_id == document_id
        ).distinct().all()
        page_numbers = sorted(set(p[0] for p in count_result if p[0]))
        if page_numbers:
            answer_context = f"[METADATA]\nThis document has {len(page_numbers)} pages total, ranging from page {min(page_numbers)} to page {max(page_numbers)}."
            return ([{"page": 1, "content": answer_context, "score": 1.0}], answer_context)

    if document_id:
        # Mode 1: Specific section ("Chapter 3", "Section 2.4", "Page 142")
        if is_specific_section_question(question):
            keywords = extract_section_keywords(question)
            if keywords:
                context, sources = build_section_context(
                    db, document_id, question, keywords
                )
                if sources:
                    return sources, context

        # Mode 2: Overview ("what's this book about", "chapter names")
        if is_overview_question(question):
            context, sources = build_overview_context(db, document_id)
            if sources:
                return sources, context

    # Mode 3 (default): Vector search
    query_vector = embed_text(question)
    chunks = search_similar(
        query_vector=query_vector,
        limit=top_k,
        document_id=document_id,
    )
    sources = [
        {
            "page": c["payload"].get("page_number"),
            "content": c["payload"].get("content"),
            "score": c["score"],
        }
        for c in chunks
    ]
    context = build_context_from_chunks(chunks)
    return sources, context


# ─── Public API ───────────────────────────────────────────────────────

def answer_question(
    db: Session,
    question: str,
    document_id: Optional[str] = None,
    history: Optional[List[Dict]] = None,
    top_k: int = 5,
) -> dict:
    """Non-streaming RAG."""
    sources, context = retrieve_for_question(db, question, document_id, top_k)

    if not sources:
        return {
            "answer": "I couldn't find any relevant content in the document to answer that.",
            "sources": [],
        }

    messages = _build_messages(question, context, history)
    response = _groq.chat.completions.create(
        model=LLM_MODEL,
        max_tokens=1024,
        temperature=0.3,
        messages=messages,
    )

    return {
        "answer": response.choices[0].message.content,
        "sources": sources,
    }


def answer_question_stream(
    db: Session,
    question: str,
    document_id: Optional[str] = None,
    history: Optional[List[Dict]] = None,
    top_k: int = 5,
) -> Iterator[Dict]:
    """Streaming RAG."""
    sources, context = retrieve_for_question(db, question, document_id, top_k)

    display_sources = sources[:5]
    yield {"type": "sources", "data": display_sources}

    if not sources:
        yield {"type": "token", "data": "I couldn't find relevant content in the document to answer that."}
        yield {"type": "done", "data": None}
        return

    messages = _build_messages(question, context, history)

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