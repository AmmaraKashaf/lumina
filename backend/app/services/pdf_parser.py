"""
PDF parsing and chunking service.
Extracts text from PDFs and splits into retrievable chunks.
"""

from io import BytesIO
from typing import List
from pypdf import PdfReader
from langchain_text_splitters import RecursiveCharacterTextSplitter


# Tuned defaults for RAG: small enough for precise retrieval,
# large enough to preserve context. Overlap prevents losing info at boundaries.
DEFAULT_CHUNK_SIZE = 800
DEFAULT_CHUNK_OVERLAP = 100


def extract_text_per_page(pdf_bytes: bytes) -> List[dict]:
    """
    Extract text from a PDF, preserving page numbers.

    Returns:
        List of {"page": int, "text": str} dicts.
    """
    reader = PdfReader(BytesIO(pdf_bytes))
    pages = []
    for i, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
            text = text.strip()
            if text:
                pages.append({"page": i + 1, "text": text})
        except Exception as e:
            print(f"⚠️  Failed to extract page {i + 1}: {e}")
            continue
    return pages


def chunk_pages(
    pages: List[dict],
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> List[dict]:
    """
    Split page text into overlapping chunks for RAG.

    Returns:
        List of {"content": str, "page": int, "chunk_index": int} dicts.
    """
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        # Try splitting on these in order — keeps paragraphs/sentences intact
        separators=["\n\n", "\n", ". ", " ", ""],
        length_function=len,
    )

    chunks = []
    global_index = 0

    for page_data in pages:
        page_chunks = splitter.split_text(page_data["text"])
        for chunk_text in page_chunks:
            chunks.append({
                "content": chunk_text,
                "page": page_data["page"],
                "chunk_index": global_index,
            })
            global_index += 1

    return chunks


def parse_pdf(pdf_bytes: bytes) -> dict:
    """
    Full pipeline: bytes → text per page → chunks.

    Returns:
        {
            "page_count": int,
            "chunks": List[{"content", "page", "chunk_index"}]
        }
    """
    pages = extract_text_per_page(pdf_bytes)
    chunks = chunk_pages(pages)

    return {
        "page_count": len(pages),
        "chunks": chunks,
    }
def download_pdf(storage_path: str) -> bytes:
    """Download a PDF from Supabase Storage and return its bytes."""
    response = _supabase_client.storage.from_(BUCKET_NAME).download(storage_path)
    return response