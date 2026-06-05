from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import text
from app.database import get_db
from app.config import settings

app = FastAPI(
    title="Lumina API",
    description="AI Knowledge Studio — RAG-powered PDF interaction platform",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    """Health check endpoint."""
    return {
        "service": "Lumina API",
        "status": "online",
        "version": "0.1.0",
        "environment": settings.ENVIRONMENT,
    }


@app.get("/health")
def health():
    return {"status": "healthy"}


@app.get("/health/db")
def db_health(db: Session = Depends(get_db)):
    """
    Verifies the database connection is working.
    Runs a simple SELECT 1 query against Supabase.
    """
    try:
        result = db.execute(text("SELECT 1 AS test")).scalar()
        return {
            "database": "connected",
            "test_query": result,
        }
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Database connection failed: {str(e)}",
        )