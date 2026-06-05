"""
Document endpoints: upload (with auto-processing), list, reprocess.
"""

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, status
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Document, User, Chunk
from app.services.storage import upload_pdf, download_pdf
from app.services.pdf_parser import parse_pdf


router = APIRouter(prefix="/documents", tags=["documents"])

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


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """
    Upload a PDF document.
    Validates file type, stores in Supabase Storage, creates DB record,
    then automatically parses and chunks the PDF in the same request.
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

    # Auto-process: parse PDF + create chunks
    chunk_count = 0
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
        document.status = "ready"
        db.commit()
        db.refresh(document)

        chunk_count = len(result["chunks"])
    except Exception as e:
        document.status = "failed"
        db.commit()
        # Don't fail the upload — file is saved, processing can be retried
        print(f"⚠️  Processing failed for {document.id}: {e}")

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