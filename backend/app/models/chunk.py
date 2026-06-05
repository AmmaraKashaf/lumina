from sqlalchemy import Column, String, Integer, Text, DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
import uuid
from app.database import Base


class Chunk(Base):
    """
    A piece of text from a PDF, used as a retrieval unit in RAG.
    Each chunk will have a corresponding vector embedding in Qdrant.
    """

    __tablename__ = "chunks"

    id = Column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        index=True,
    )
    document_id = Column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    content = Column(Text, nullable=False)  # the actual chunk text
    chunk_index = Column(Integer, nullable=False)  # position in the doc (0, 1, 2...)
    page_number = Column(Integer, nullable=True)
    chunk_metadata = Column(JSONB, nullable=True)  # section, heading, etc.
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationship back to parent document
    document = relationship("Document", back_populates="chunks")

    def __repr__(self):
        return f"<Chunk(doc={self.document_id}, idx={self.chunk_index})>"