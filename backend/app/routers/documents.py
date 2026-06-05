"""
Document endpoints: upload, list, delete.
"""

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, status
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Document, User
from app.services.storage import upload_pdf
import uuid


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
    Validates file type, stores in Supabase Storage, creates DB record.
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
    max_size = 50 * 1024 * 1024  # 50 MB in bytes
    if len(file_bytes) > max_size:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Max size: 50 MB. Got: {len(file_bytes) / 1024 / 1024:.1f} MB",
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

    # Create database record
    document = Document(
        user_id=user.id,
        title=file.filename or "Untitled",
        filename=file.filename or "unnamed.pdf",
        file_url=storage_result["path"],
        status="pending",
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    return {
        "id": str(document.id),
        "title": document.title,
        "filename": document.filename,
        "status": document.status,
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
            "created_at": doc.created_at.isoformat(),
        }
        for doc in documents
    ]