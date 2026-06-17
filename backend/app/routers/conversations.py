"""
Conversation endpoints — create chats, send messages with memory, stream responses.
All endpoints require a valid JWT; users can only access their own conversations.
"""

import json
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.database import get_db, SessionLocal
from app.models import Conversation, Message, Document, User
from app.auth import get_current_user
from app.services.rag import answer_question_stream


router = APIRouter(prefix="/conversations", tags=["conversations"])


# ─── Schemas ────────────────────────────────────────────────────────────

class CreateConversationRequest(BaseModel):
    document_id: str
    title: Optional[str] = None


class MessageOut(BaseModel):
    id: str
    role: str
    content: str
    sources: Optional[list] = None
    created_at: str


class ConversationOut(BaseModel):
    id: str
    document_id: str
    title: Optional[str]
    created_at: str
    message_count: int


class ConversationDetail(ConversationOut):
    messages: List[MessageOut]


class SendMessageRequest(BaseModel):
    content: str
    top_k: int = 10


# ─── Helpers ────────────────────────────────────────────────────────────

def _get_conversation_history(db: Session, conv_id: str) -> List[dict]:
    msgs = (
        db.query(Message)
        .filter(Message.conversation_id == conv_id)
        .order_by(Message.created_at)
        .all()
    )
    return [{"role": m.role, "content": m.content} for m in msgs]


def _auto_title(question: str) -> str:
    title = question.strip().replace("\n", " ")
    return title[:60] + ("..." if len(title) > 60 else "")


def _get_owned_conversation(conversation_id: str, user: User, db: Session) -> Conversation:
    conv = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.user_id == user.id,
    ).first()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


# ─── Endpoints ──────────────────────────────────────────────────────────

@router.post("/", response_model=ConversationOut)
def create_conversation(
    request: CreateConversationRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Start a new chat session bound to a document the user owns."""
    doc = db.query(Document).filter(
        Document.id == request.document_id,
        Document.user_id == current_user.id,
    ).first()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    conv = Conversation(
        user_id=current_user.id,
        document_id=doc.id,
        title=request.title,
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)

    return ConversationOut(
        id=str(conv.id),
        document_id=str(conv.document_id),
        title=conv.title,
        created_at=conv.created_at.isoformat(),
        message_count=0,
    )


@router.get("/", response_model=List[ConversationOut])
def list_conversations(
    document_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all conversations belonging to the current user."""
    q = db.query(Conversation).filter(Conversation.user_id == current_user.id)
    if document_id:
        q = q.filter(Conversation.document_id == document_id)
    convs = q.order_by(Conversation.updated_at.desc()).all()

    return [
        ConversationOut(
            id=str(c.id),
            document_id=str(c.document_id),
            title=c.title,
            created_at=c.created_at.isoformat(),
            message_count=len(c.messages),
        )
        for c in convs
    ]


@router.get("/{conversation_id}", response_model=ConversationDetail)
def get_conversation(
    conversation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a conversation with all its messages."""
    conv = _get_owned_conversation(conversation_id, current_user, db)

    return ConversationDetail(
        id=str(conv.id),
        document_id=str(conv.document_id),
        title=conv.title,
        created_at=conv.created_at.isoformat(),
        message_count=len(conv.messages),
        messages=[
            MessageOut(
                id=str(m.id),
                role=m.role,
                content=m.content,
                sources=m.sources,
                created_at=m.created_at.isoformat(),
            )
            for m in conv.messages
        ],
    )


@router.delete("/{conversation_id}")
def delete_conversation(
    conversation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a conversation and all its messages."""
    conv = _get_owned_conversation(conversation_id, current_user, db)
    db.delete(conv)
    db.commit()
    return {"deleted": True}


@router.post("/{conversation_id}/messages/stream")
def send_message_stream(
    conversation_id: str,
    request: SendMessageRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Send a message and stream the AI's response token-by-token (SSE)."""
    conv = _get_owned_conversation(conversation_id, current_user, db)

    if not request.content.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    user_msg = Message(
        conversation_id=conv.id,
        role="user",
        content=request.content,
    )
    db.add(user_msg)

    if conv.title is None:
        conv.title = _auto_title(request.content)

    db.commit()

    history = _get_conversation_history(db, str(conv.id))
    history_for_llm = history[:-1] if history else []

    document_id = str(conv.document_id)
    question = request.content
    conv_id = str(conv.id)
    top_k = request.top_k

    def event_stream():
        full_answer = ""
        captured_sources = []
        stream_db = SessionLocal()

        try:
            for event in answer_question_stream(
                db=stream_db,
                question=question,
                document_id=document_id,
                history=history_for_llm,
                top_k=top_k,
            ):
                if event["type"] == "sources":
                    captured_sources = event["data"]
                elif event["type"] == "token":
                    full_answer += event["data"]
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'data': str(e)})}\n\n"
            stream_db.close()
            return

        try:
            asst_msg = Message(
                conversation_id=conv_id,
                role="assistant",
                content=full_answer,
                sources=captured_sources,
            )
            stream_db.add(asst_msg)
            stream_db.commit()
        finally:
            stream_db.close()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
