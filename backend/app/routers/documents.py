"""
Document endpoints: upload (with auto-processing), list, reprocess.
"""

from fastapi import APIRouter, BackgroundTasks, Depends, UploadFile, File, HTTPException, Response, status
from sqlalchemy.orm import Session
from app.database import get_db, SessionLocal
from app.models import Document, User, Chunk
from app.services.storage import upload_pdf, download_pdf, delete_pdf
from app.services.pdf_parser import parse_pdf


router = APIRouter(prefix="/documents", tags=["documents"])


def _index_in_background(document_id: str) -> None:
    """Embed all chunks for a document and upsert them to Qdrant (runs as a background task)."""
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

# Temporary hardcoded user — we'll replace with real auth in Step 12
TEST_USER_EMAIL = "test@lumina.dev"


def get_or_create_test_user(db: Session) -> User:
    """Returns the test user, creating one if it doesn't exist."""
    user = db.query(User).filter(User.email == TEST_USER_EMAIL).first()
    if user is None:
        user = User(email=TEST_USER_EMAIL, name="Test User")
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


@router.get("/{document_id}/status")
def get_document_status(document_id: str, db: Session = Depends(get_db)):
    """Poll the processing/indexing status of a document."""
    doc = db.query(Document).filter(Document.id == document_id).first()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"document_id": document_id, "status": doc.status, "page_count": doc.page_count}


def _cleanup_after_delete(document_id: str, file_url: str | None) -> None:
    """Background task: remove Qdrant vectors and the Storage file after the DB record is gone."""
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
):
    """
    Instantly delete a document then clean up Qdrant vectors + Storage file in the background.
    DB-level CASCADE handles chunks → conversations → messages automatically.
    """
    doc = db.query(Document).filter(Document.id == document_id).first()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    file_url = doc.file_url

    # Direct SQL DELETE — lets the DB CASCADE handle child rows without loading them into ORM.
    db.query(Document).filter(Document.id == document_id).delete(synchronize_session=False)
    db.commit()

    # Qdrant + Storage cleanup runs after the response is sent — user never waits for it.
    background_tasks.add_task(_cleanup_after_delete, document_id, file_url)

    return Response(status_code=204)


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """
    Upload a PDF document.
    Validates file type, stores in Supabase Storage, creates DB record,
    parses and chunks the PDF, then auto-indexes embeddings in the background.
    """
    # Validate content type
    if file.content_type != "application/pdf":
        raise HTTPException(
            status_code=400,
            detail=f"Only PDF files are allowed. Got: {file.content_type}",
        )

    # Read the file into memory
    file_bytes = await file.read()

    # Check file size (50 MB max)
    max_size = 50 * 1024 * 1024
    if len(file_bytes) > max_size:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Max 50 MB. Got: {len(file_bytes) / 1024 / 1024:.1f} MB",
        )

    # Get/create test user
    user = get_or_create_test_user(db)

    # Upload to Supabase Storage
    try:
        storage_result = upload_pdf(
            file_bytes=file_bytes,
            original_filename=file.filename or "unnamed.pdf",
            user_id=str(user.id),
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Storage upload failed: {str(e)}",
        )

    # Create database record (status starts as "processing")
    document = Document(
        user_id=user.id,
        title=file.filename or "Untitled",
        filename=file.filename or "unnamed.pdf",
        file_url=storage_result["path"],
        status="processing",
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    # Parse PDF + create chunks (synchronous), then kick off background indexing
    chunk_count = 0
    processing_ok = False
    try:
        result = parse_pdf(file_bytes)  # reuse bytes already in memory

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
        document.status = "indexing"   # background task will flip this to "ready"
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
def list_documents(db: Session = Depends(get_db)):
    """List all documents for the test user."""
    user = get_or_create_test_user(db)
    documents = (
        db.query(Document)
        .filter(Document.user_id == user.id)
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
):
    """
    Manually re-process a PDF (useful for documents that failed or pre-date auto-processing).
    Parses the PDF, generates chunks, updates status.
    """
    document = db.query(Document).filter(Document.id == document_id).first()
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if document.status == "ready":
        return {
            "message": "Document already processed",
            "document_id": str(document.id),
            "chunk_count": len(document.chunks),
        }

    document.status = "processing"
    db.commit()

    try:
        # Download bytes from storage
        pdf_bytes = download_pdf(document.file_url)

        # Parse and chunk
        result = parse_pdf(pdf_bytes)

        # Delete any old chunks before re-creating (avoids duplicates on retry)
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
        raise HTTPException(
            status_code=500,
            detail=f"Processing failed: {str(e)}",
        )
    
@router.post("/{document_id}/index")
def index_document(
    document_id: str,
    db: Session = Depends(get_db),
):
    """
    Generate embeddings for all chunks of a document and store in Qdrant.
    This is what makes the document searchable.
    """
    from app.services.embeddings import embed_batch
    from app.services.vector_store import ensure_collection, upsert_chunks, delete_chunks_for_document

    document = db.query(Document).filter(Document.id == document_id).first()
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if document.status != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"Document must be 'ready' first (current: {document.status})",
        )

    chunks = db.query(Chunk).filter(Chunk.document_id == document.id).all()
    if not chunks:
        raise HTTPException(status_code=400, detail="No chunks found for this document")

    # Ensure Qdrant collection exists
    ensure_collection()

    # Delete any old vectors for this document (in case of re-indexing)
    delete_chunks_for_document(str(document.id))

    try:
        # Generate embeddings (this is the slow part — ~1-2s per chunk on HF free tier)
        print(f"🧠 Generating embeddings for {len(chunks)} chunks...")
        contents = [c.content for c in chunks]
        vectors = embed_batch(contents)

        # Build points for Qdrant
        points = [
            {
                "id": str(chunk.id),
                "vector": vector,
                "payload": {
                    "document_id": str(document.id),
                    "document_title": document.title,
                    "content": chunk.content,
                    "chunk_index": chunk.chunk_index,
                    "page_number": chunk.page_number,
                },
            }
            for chunk, vector in zip(chunks, vectors)
        ]

        # Upload to Qdrant
        count = upsert_chunks(points)

        return {
            "message": "Indexing complete",
            "document_id": str(document.id),
            "chunks_indexed": count,
        }

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Indexing failed: {str(e)}",
        )
@router.post("/{document_id}/search")
def search_document(
    document_id: str,
    query: str,
    limit: int = 5,
    db: Session = Depends(get_db),
):
    """
    Semantic search within a document.
    Returns the chunks most relevant to the query.
    """
    from app.services.embeddings import embed_text
    from app.services.vector_store import search_similar

    document = db.query(Document).filter(Document.id == document_id).first()
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # Embed the user's query
    query_vector = embed_text(query)

    # Search Qdrant
    results = search_similar(
        query_vector=query_vector,
        limit=limit,
        document_id=str(document.id),
    )

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