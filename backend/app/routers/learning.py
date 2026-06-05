"""
Learning endpoints — summaries, quizzes, flashcards.
"""

from typing import List, Literal, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Document
from app.services.learning import (
    generate_summary,
    generate_quiz,
    generate_flashcards,
    SummaryStyle,
)


router = APIRouter(prefix="/learning", tags=["learning"])


# ─── Schemas ──────────────────────────────────────────────────────────

class SummaryRequest(BaseModel):
    document_id: str
    style: Literal["tldr", "executive", "detailed", "eli5"] = "tldr"


class SummaryResponse(BaseModel):
    document_id: str
    style: str
    summary: str


class QuizRequest(BaseModel):
    document_id: str
    num_questions: int = Field(default=5, ge=1, le=20)


class QuizQuestion(BaseModel):
    question: str
    options: List[str]
    correct_index: int
    explanation: Optional[str] = None
    page: Optional[int] = None


class QuizResponse(BaseModel):
    document_id: str
    questions: List[QuizQuestion]


class FlashcardRequest(BaseModel):
    document_id: str
    num_cards: int = Field(default=10, ge=1, le=30)


class Flashcard(BaseModel):
    front: str
    back: str
    page: Optional[int] = None


class FlashcardResponse(BaseModel):
    document_id: str
    flashcards: List[Flashcard]


# ─── Helpers ──────────────────────────────────────────────────────────

def _ensure_document_ready(db: Session, document_id: str) -> Document:
    """Validate that the document exists and is processed."""
    document = db.query(Document).filter(Document.id == document_id).first()
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if document.status != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"Document must be ready first (current status: {document.status})",
        )
    return document


# ─── Endpoints ────────────────────────────────────────────────────────

@router.post("/summary", response_model=SummaryResponse)
def create_summary(request: SummaryRequest, db: Session = Depends(get_db)):
    """Generate a summary in the requested style."""
    _ensure_document_ready(db, request.document_id)

    try:
        summary = generate_summary(db, request.document_id, style=request.style)
        return SummaryResponse(
            document_id=request.document_id,
            style=request.style,
            summary=summary,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Summary failed: {str(e)}")


@router.post("/quiz", response_model=QuizResponse)
def create_quiz(request: QuizRequest, db: Session = Depends(get_db)):
    """Generate a multiple-choice quiz."""
    _ensure_document_ready(db, request.document_id)

    try:
        questions = generate_quiz(db, request.document_id, num_questions=request.num_questions)
        if not questions:
            raise HTTPException(status_code=500, detail="LLM returned no questions")

        return QuizResponse(
            document_id=request.document_id,
            questions=questions,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Quiz generation failed: {str(e)}")


@router.post("/flashcards", response_model=FlashcardResponse)
def create_flashcards(request: FlashcardRequest, db: Session = Depends(get_db)):
    """Generate study flashcards."""
    _ensure_document_ready(db, request.document_id)

    try:
        cards = generate_flashcards(db, request.document_id, num_cards=request.num_cards)
        if not cards:
            raise HTTPException(status_code=500, detail="LLM returned no flashcards")

        return FlashcardResponse(
            document_id=request.document_id,
            flashcards=cards,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Flashcard generation failed: {str(e)}")