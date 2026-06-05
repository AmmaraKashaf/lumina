from sqlalchemy import Column, String, Integer, DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
import uuid
from app.database import Base


class Document(Base):
    """A PDF uploaded by a user. Contains many chunks once processed."""

    __tablename__ = "documents"

    id = Column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        index=True,
    )
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title = Column(String, nullable=False)
    filename = Column(String, nullable=False)
    file_url = Column(String, nullable=True)  # storage URL after upload
    page_count = Column(Integer, nullable=True)
    status = Column(String, default="pending")  # pending | processing | ready | failed
    doc_metadata = Column(JSONB, nullable=True)  # author, abstract, etc.
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
    )

    # Relationships
    chunks = relationship(
        "Chunk",
        back_populates="document",
        cascade="all, delete-orphan",
    )

    def __repr__(self):
        return f"<Document(title={self.title}, status={self.status})>"