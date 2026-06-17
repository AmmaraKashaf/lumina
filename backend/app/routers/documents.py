"""
Document endpoints: upload (with auto-processing), list, delete, reprocess.
All endpoints require a valid Supabase JWT — every user sees only their own data.
"""

from fastapi import APIRouter, BackgroundTasks, Depends, UploadFile, File, HTTPException, Response, status
from sqlalchemy.orm import Session
from app.database import get_db, SessionLocal
from app.models import Document, User, Chunk
from app.auth import get_current_user
from app.services.storage import upload_pdf, download_pdf, delete_pdf
from app.services.pdf_parser import parse_pdf


router = APIRouter(prefix="/documents", tags=["documents"])


def _index_in_background(document_id: str) -> None:
    """Embed all chunks and upsert them to Qdrant (background task, no auth needed)."""
    from app.services.embeddings import embed_batch
    from app.services.vector_store import delete_chunks_for_document, ensure_collection, upsert_chunks

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
                    "user_id": str(document.user_id),
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
        print(f"✅  Auto-indexing complete for {document_id} ({len(chunks)} chunks)")

    except Exception as exc:
        print(f"⚠️  Auto-indexing failed for {document_id}: {exc}")
        try:
            doc = db.query(Document).filter(Document.id == document_id).first()
            if doc:
                doc.status = "index_failed"
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _get_owned_document(document_id: str, user: User, db: Session) -> Document:
    """Return a document only if it belongs to the current user, else raise 404."""
    doc = db.query(Document).filter(
        Document.id == document_id,
        Document.user_id == user.id,
    ).first()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@router.get("/{document_id}/status")
def get_document_status(
    document_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Poll the processing/indexing status of a document."""
    doc = _get_owned_document(document_id, current_user, db)
    return {"document_id": document_id, "status": doc.status, "page_count": doc.page_count}


def _cleanup_after_delete(document_id: str, file_url: str | None) -> None:
    """Background task: remove Qdrant vectors and the Storage file after DB record is gone."""
    from app.services.vector_store import delete_chunks_for_document

    try:
        delete_chunks_for_document(document_id)
    except Exception as exc:
        print(f"⚠️  Qdrant cleanup failed for {document_id}: {exc}")

    if file_url:
        try:
            delete_pdf(file_url)
        except Exception as exc:
            print(f"⚠️  Storage cleanup failed for {document_id}: {exc}")


@router.delete("/{document_id}", status_code=204)
def delete_document(
    document_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a document (and cascade its chunks/conversations/messages)."""
    doc = _get_owned_document(document_id, current_user, db)
    file_url = doc.file_url

    db.query(Document).filter(
        Document.id == document_id,
        Document.user_id == current_user.id,
    ).delete(synchronize_session=False)
    db.commit()

    background_tasks.add_task(_cleanup_after_delete, document_id, file_url)
    return Response(status_code=204)


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a PDF, store it, parse+chunk it, then auto-index embeddings."""
    if file.content_type != "application/pdf":
        raise HTTPException(
            status_code=400,
            detail=f"Only PDF files are allowed. Got: {file.content_type}",
        )

    file_bytes = await file.read()

    if len(file_bytes) > 50 * 1024 * 1024:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Max 50 MB. Got: {len(file_bytes) / 1024 / 1024:.1f} MB",
        )

    try:
        storage_result = upload_pdf(
            file_bytes=file_bytes,
            original_filename=file.filename or "unnamed.pdf",
            user_id=str(current_user.id),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Storage upload failed: {str(e)}")

    document = Document(
        user_id=current_user.id,
        title=file.filename or "Untitled",
        filename=file.filename or "unnamed.pdf",
        file_url=storage_result["path"],
        status="processing",
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    chunk_count = 0
    processing_ok = False
    try:
        result = parse_pdf(file_bytes)
        chunk_objects = [
            Chunk(
                document_id=document.id,
                content=chunk["content"],
                chunk_index=chunk["chunk_index"],
                page_number=chunk["page"],
            )
            for chunk in result["chunks"]
        ]
        db.bulk_save_objects(chunk_objects)
        document.page_count = result["page_count"]
        document.status = "indexing"
        db.commit()
        db.refresh(document)
        chunk_count = len(result["chunks"])
        processing_ok = True
    except Exception as e:
        document.status = "failed"
        db.commit()
        print(f"⚠️  Processing failed for {document.id}: {e}")

    if processing_ok:
        background_tasks.add_task(_index_in_background, str(document.id))

    return {
        "id": str(document.id),
        "title": document.title,
        "filename": document.filename,
        "status": document.status,
        "page_count": document.page_count,
        "chunk_count": chunk_count,
        "signed_url": storage_result["signed_url"],
    }


@router.get("/")
def list_documents(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all documents belonging to the current user."""
    documents = (
        db.query(Document)
        .filter(Document.user_id == current_user.id)
        .order_by(Document.created_at.desc())
        .all()
    )
    return [
        {
            "id": str(doc.id),
            "title": doc.title,
            "filename": doc.filename,
            "status": doc.status,
            "page_count": doc.page_count,
            "chunk_count": len(doc.chunks),
            "created_at": doc.created_at.isoformat(),
        }
        for doc in documents
    ]


@router.post("/{document_id}/process")
def process_document(
    document_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Manually re-process a PDF (parse + chunk + re-index)."""
    document = _get_owned_document(document_id, current_user, db)

    if document.status == "ready":
        return {
            "message": "Document already processed",
            "document_id": str(document.id),
            "chunk_count": len(document.chunks),
        }

    document.status = "processing"
    db.commit()

    try:
        pdf_bytes = download_pdf(document.file_url)
        result = parse_pdf(pdf_bytes)

        db.query(Chunk).filter(Chunk.document_id == document.id).delete()

        chunk_objects = [
            Chunk(
                document_id=document.id,
                content=chunk["content"],
                chunk_index=chunk["chunk_index"],
                page_number=chunk["page"],
            )
            for chunk in result["chunks"]
        ]
        db.bulk_save_objects(chunk_objects)

        document.page_count = result["page_count"]
        document.status = "ready"
        db.commit()
        db.refresh(document)

        return {
            "message": "Processing complete",
            "document_id": str(document.id),
            "page_count": document.page_count,
            "chunk_count": len(result["chunks"]),
        }

    except Exception as e:
        document.status = "failed"
        db.commit()
        raise HTTPException(status_code=500, detail=f"Processing failed: {str(e)}")


@router.post("/{document_id}/index")
def index_document(
    document_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate embeddings for all chunks and store in Qdrant."""
    from app.services.embeddings import embed_batch
    from app.services.vector_store import ensure_collection, upsert_chunks, delete_chunks_for_document

    document = _get_owned_document(document_id, current_user, db)

    if document.status != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"Document must be 'ready' first (current: {document.status})",
        )

    chunks = db.query(Chunk).filter(Chunk.document_id == document.id).all()
    if not chunks:
        raise HTTPException(status_code=400, detail="No chunks found for this document")

    ensure_collection()
    delete_chunks_for_document(str(document.id))

    try:
        contents = [c.content for c in chunks]
        vectors = embed_batch(contents)

        points = [
            {
                "id": str(chunk.id),
                "vector": vector,
                "payload": {
                    "document_id": str(document.id),
                    "user_id": str(current_user.id),
                    "document_title": document.title,
                    "content": chunk.content,
                    "chunk_index": chunk.chunk_index,
                    "page_number": chunk.page_number,
                },
            }
            for chunk, vector in zip(chunks, vectors)
        ]

        count = upsert_chunks(points)
        return {
            "message": "Indexing complete",
            "document_id": str(document.id),
            "chunks_indexed": count,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Indexing failed: {str(e)}")


@router.post("/{document_id}/search")
def search_document(
    document_id: str,
    query: str,
    limit: int = 5,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Semantic search within a document."""
    from app.services.embeddings import embed_text
    from app.services.vector_store import search_similar

    document = _get_owned_document(document_id, current_user, db)
    query_vector = embed_text(query)
    results = search_similar(query_vector=query_vector, limit=limit, document_id=str(document.id))

    return {
        "query": query,
        "results": [
            {
                "score": r["score"],
                "content": r["payload"]["content"],
                "page": r["payload"].get("page_number"),
                "chunk_index": r["payload"].get("chunk_index"),
            }
            for r in results
        ],
    }
