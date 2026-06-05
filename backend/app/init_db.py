"""
One-off script to create all database tables.
Run with: python -m app.init_db
"""

from app.database import engine, Base
from app.models import User, Document, Chunk  # noqa: F401 — registers models


def create_tables():
    print("Creating tables...")
    Base.metadata.create_all(bind=engine)
    print("✅ Tables created successfully")


if __name__ == "__main__":
    create_tables()