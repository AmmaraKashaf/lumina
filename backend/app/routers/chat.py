"""
Chat endpoints — ask questions about PDFs (stateless, non-streaming).
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Document, User
from app.auth import get_current_user
from app.services.rag import answer_question


router = APIRouter(prefix="/chat", tags=["chat"])


class ChatRequest(BaseModel):
    question: str
    document_id: Optional[str] = None
    top_k: int = 5


class Source(BaseModel):
    page: Optional[int]
    content: str
    score: float


class ChatResponse(BaseModel):
    answer: str
    sources: List[Source]


@router.post("/", response_model=ChatResponse)
def chat(
    request: ChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Ask a question. Returns AI answer grounded in document chunks."""
    if not request.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    if request.document_id:
        doc = db.query(Document).filter(
            Document.id == request.document_id,
            Document.user_id == current_user.id,
        ).first()
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")

    try:
        result = answer_question(
            db=db,
            question=request.question,
            document_id=request.document_id,
            top_k=request.top_k,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Chat failed: {str(e)}")
