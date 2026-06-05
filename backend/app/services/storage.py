"""
Supabase Storage service — handles PDF file uploads.
"""

from supabase import create_client, Client
from app.config import settings
import uuid


# Single Supabase client reused across requests
_supabase_client: Client = create_client(
    settings.SUPABASE_URL,
    settings.SUPABASE_SERVICE_KEY,  # service key bypasses RLS
)

BUCKET_NAME = "pdfs"


def upload_pdf(file_bytes: bytes, original_filename: str, user_id: str) -> dict:
    """
    Upload a PDF file to Supabase Storage.

    Args:
        file_bytes: raw file content
        original_filename: name from user's upload
        user_id: owner of the file

    Returns:
        dict with `path` and `public_url` (signed for private access)
    """
    # Generate a unique storage path: user_id/uuid_filename.pdf
    file_id = str(uuid.uuid4())
    safe_filename = original_filename.replace(" ", "_")
    storage_path = f"{user_id}/{file_id}_{safe_filename}"

    # Upload to Supabase Storage
    _supabase_client.storage.from_(BUCKET_NAME).upload(
        path=storage_path,
        file=file_bytes,
        file_options={"content-type": "application/pdf"},
    )

    # Generate a signed URL valid for 1 hour (for previewing)
    signed = _supabase_client.storage.from_(BUCKET_NAME).create_signed_url(
        path=storage_path,
        expires_in=3600,  # seconds
    )

    return {
        "path": storage_path,
        "signed_url": signed.get("signedURL"),
    }


def delete_pdf(storage_path: str) -> None:
    """Delete a PDF from storage."""
    _supabase_client.storage.from_(BUCKET_NAME).remove([storage_path])