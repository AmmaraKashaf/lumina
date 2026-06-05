"""
Chat endpoints — ask questions about PDFs.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
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
def chat(request: ChatRequest):
    """Ask a question. Returns AI answer grounded in document chunks."""
    if not request.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    try:
        result = answer_question(
            question=request.question,
            document_id=request.document_id,
            top_k=request.top_k,
        )
        return result
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Chat failed: {str(e)}",
        )