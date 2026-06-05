"""
Mind map endpoints — generate, fetch, regenerate.
"""

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Document, MindMap
from app.services.mindmap import generate_mindmap


router = APIRouter(prefix="/mindmaps", tags=["mindmaps"])


# ─── Schemas ──────────────────────────────────────────────────────────

class MindMapResponse(BaseModel):
    id: str
    document_id: str
    title: Optional[str]
    data: dict  # {nodes: [...], edges: [...]}
    cached: bool  # True if loaded from DB, False if freshly generated
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


# ─── Endpoints ────────────────────────────────────────────────────────

@router.get("/{document_id}", response_model=MindMapResponse)
def get_or_create_mindmap(
    document_id: str,
    regenerate: bool = False,
    db: Session = Depends(get_db),
):
    """
    Get the mind map for a document.
    - If one exists and regenerate=False → return cached version (fast)
    - Otherwise → generate fresh and save to DB (slow ~5s)
    """
    document = db.query(Document).filter(Document.id == document_id).first()
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if document.status != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"Document must be ready first (status: {document.status})",
        )

    # Check for cached version
    existing = (
        db.query(MindMap)
        .filter(MindMap.document_id == document_id)
        .order_by(MindMap.created_at.desc())
        .first()
    )

    if existing and not regenerate:
        return _serialize(existing, cached=True)

    # Generate fresh
    try:
        data = generate_mindmap(db, document_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Mind map generation failed: {str(e)}")

    # If regenerating, delete old one to keep DB clean
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
def delete_mindmap(document_id: str, db: Session = Depends(get_db)):
    """Delete all mind maps for a document (allows fresh regeneration)."""
    deleted = db.query(MindMap).filter(MindMap.document_id == document_id).delete()
    db.commit()
    return {"deleted": deleted}