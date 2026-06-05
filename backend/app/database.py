from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from app.config import settings

# Convert Supabase URL to SQLAlchemy format if needed
# Supabase gives: postgresql://...
# SQLAlchemy expects: postgresql+psycopg2://...
db_url = settings.DATABASE_URL
if db_url.startswith("postgresql://"):
    db_url = db_url.replace("postgresql://", "postgresql+psycopg2://", 1)

# Create the database engine
engine = create_engine(
    db_url,
    pool_pre_ping=True,  # checks connection is alive before using
    pool_size=5,
    max_overflow=10,
    echo=False,  # set True for SQL debug logs
)

# Session factory — used to talk to DB
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class for all our database models (tables)
Base = declarative_base()


def get_db():
    """
    FastAPI dependency: provides a database session per request,
    closes it cleanly when done.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()