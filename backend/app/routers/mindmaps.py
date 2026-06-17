"""
Mind map endpoints — generate, fetch, regenerate.
Users can only access mind maps for documents they own.
"""

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Document, MindMap, User
from app.auth import get_current_user
from app.services.mindmap import generate_mindmap


router = APIRouter(prefix="/mindmaps", tags=["mindmaps"])


# ─── Schemas ──────────────────────────────────────────────────────────

class MindMapResponse(BaseModel):
    id: str
    document_id: str
    title: Optional[str]
    data: dict
    cached: bool
    created_at: str


# ─── Helpers ──────────────────────────────────────────────────────────

def _serialize(mindmap: MindMap, cached: bool) -> MindMapResponse:
    return MindMapResponse(
        id=str(mindmap.id),
        document_id=str(mindmap.document_id),
        title=mindmap.title,
        data=mindmap.data,
        cached=cached,
        created_at=mindmap.created_at.isoformat(),
    )


def _get_owned_ready_document(document_id: str, user: User, db: Session) -> Document:
    document = db.query(Document).filter(
        Document.id == document_id,
        Document.user_id == user.id,
    ).first()
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if document.status != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"Document must be ready first (status: {document.status})",
        )
    return document


# ─── Endpoints ────────────────────────────────────────────────────────

@router.get("/{document_id}", response_model=MindMapResponse)
def get_or_create_mindmap(
    document_id: str,
    regenerate: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get the mind map for a document.
    Returns cached version unless regenerate=True.
    """
    document = _get_owned_ready_document(document_id, current_user, db)

    existing = (
        db.query(MindMap)
        .filter(MindMap.document_id == document_id)
        .order_by(MindMap.created_at.desc())
        .first()
    )

    if existing and not regenerate:
        return _serialize(existing, cached=True)

    try:
        data = generate_mindmap(db, document_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Mind map generation failed: {str(e)}")

    if existing and regenerate:
        db.delete(existing)
        db.commit()

    mindmap = MindMap(
        document_id=document.id,
        title=data.get("title") or document.title,
        data=data,
    )
    db.add(mindmap)
    db.commit()
    db.refresh(mindmap)

    return _serialize(mindmap, cached=False)


@router.delete("/{document_id}")
def delete_mindmap(
    document_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete all mind maps for a document (requires ownership)."""
    _get_owned_ready_document(document_id, current_user, db)
    deleted = db.query(MindMap).filter(MindMap.document_id == document_id).delete()
    db.commit()
    return {"deleted": deleted}
