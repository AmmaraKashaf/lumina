"""
Document Conversion API.

POST /converter/upload          Upload .docx or .pdf, convert, chunk, background-index.
GET  /converter/{id}/status     Poll indexing progress.
"""

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from fastapi import status as http_status
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db
from app.models import Chunk, Document, User
from app.services.pdf_parser import parse_pdf
from app.services.storage import upload_pdf

router = APIRouter(prefix="/converter", tags=["converter"])

_TEST_USER_EMAIL = "test@lumina.dev"


# ── helpers ──────────────────────────────────────────────────────────────────

def _get_or_create_test_user(db: Session) -> User:
    user = db.query(User).filter(User.email == _TEST_USER_EMAIL).first()
    if user is None:
        user = User(email=_TEST_USER_EMAIL, name="Test User")
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


def _index_in_background(document_id: str) -> None:
    """Embed all chunks for *document_id* and upsert them to Qdrant."""
    from app.services.embeddings import embed_batch
    from app.services.vector_store import (
        delete_chunks_for_document,
        ensure_collection,
        upsert_chunks,
    )

    db = SessionLocal()
    try:
        document = db.query(Document).filter(Document.id == document_id).first()
        if not document:
            return

        chunks = db.query(Chunk).filter(Chunk.document_id == document.id).all()
        if not chunks:
            document.status = "ready"
            db.commit()
            return

        ensure_collection()
        delete_chunks_for_document(document_id)

        vectors = embed_batch([c.content for c in chunks])
        points = [
            {
                "id": str(chunk.id),
                "vector": vector,
                "payload": {
                    "document_id": document_id,
                    "document_title": document.title,
                    "content": chunk.content,
                    "chunk_index": chunk.chunk_index,
                    "page_number": chunk.page_number,
                },
            }
            for chunk, vector in zip(chunks, vectors)
        ]
        upsert_chunks(points)

        document.status = "ready"
        db.commit()

    except Exception as exc:
        print(f"⚠️  Background indexing failed for {document_id}: {exc}")
        try:
            doc = db.query(Document).filter(Document.id == document_id).first()
            if doc:
                doc.status = "index_failed"
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.post("/upload", status_code=http_status.HTTP_201_CREATED)
async def upload_and_convert(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """
    Accept a .pdf or .docx file.
    - .docx  → convert to PDF, then process
    - .pdf   → process directly
    Chunking is synchronous; embedding runs as a background task.
    """
    filename = file.filename or "document"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext not in ("pdf", "docx", "doc"):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '.{ext}'. Upload a .pdf or .docx file.",
        )
    if ext == "doc":
        raise HTTPException(
            status_code=400,
            detail=(
                "Legacy .doc format is not supported. "
                "Open the file in Word and save it as .docx, then re-upload."
            ),
        )

    file_bytes = await file.read()

    if not file_bytes:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(file_bytes) > 50 * 1024 * 1024:
        raise HTTPException(
            status_code=400,
            detail=f"File too large ({len(file_bytes) / 1024 / 1024:.1f} MB). Maximum is 50 MB.",
        )

    # ── convert if DOCX ──────────────────────────────────────────────────────
    converted = False
    pdf_filename = filename

    if ext == "docx":
        from app.services.converter import convert_docx_to_pdf
        try:
            file_bytes = convert_docx_to_pdf(file_bytes)
            pdf_filename = filename.rsplit(".", 1)[0] + ".pdf"
            converted = True
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Conversion failed: {exc}")

    # ── upload to Supabase Storage ────────────────────────────────────────────
    user = _get_or_create_test_user(db)
    try:
        storage = upload_pdf(file_bytes, pdf_filename, str(user.id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Storage upload failed: {exc}")

    # ── create Document record ────────────────────────────────────────────────
    document = Document(
        user_id=user.id,
        title=pdf_filename,
        filename=pdf_filename,
        file_url=storage["path"],
        status="processing",
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    # ── parse & chunk (synchronous) ───────────────────────────────────────────
    try:
        result = parse_pdf(file_bytes)

        if not result["chunks"]:
            document.status = "failed"
            db.commit()
            raise HTTPException(
                status_code=422,
                detail=(
                    "No text could be extracted from this document. "
                    "It may be a scanned/image-only PDF."
                ),
            )

        db.bulk_save_objects([
            Chunk(
                document_id=document.id,
                content=chunk["content"],
                chunk_index=chunk["chunk_index"],
                page_number=chunk["page"],
            )
            for chunk in result["chunks"]
        ])
        document.page_count = result["page_count"]
        document.status = "indexing"
        db.commit()
        db.refresh(document)
        chunk_count = len(result["chunks"])

    except HTTPException:
        raise
    except Exception as exc:
        document.status = "failed"
        db.commit()
        raise HTTPException(status_code=500, detail=f"Processing failed: {exc}")

    # ── kick off background indexing ──────────────────────────────────────────
    background_tasks.add_task(_index_in_background, str(document.id))

    return {
        "document_id": str(document.id),
        "original_filename": filename,
        "pdf_filename": pdf_filename,
        "converted": converted,
        "status": "indexing",
        "page_count": document.page_count,
        "chunk_count": chunk_count,
        "download_url": storage["signed_url"],
    }


@router.get("/{document_id}/status")
def get_conversion_status(document_id: str, db: Session = Depends(get_db)):
    """Poll the indexing status of a previously uploaded document."""
    doc = db.query(Document).filter(Document.id == document_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found.")
    return {
        "document_id": document_id,
        "status": doc.status,
        "page_count": doc.page_count,
    }
