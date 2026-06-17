from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import text
from app.database import get_db
from app.config import settings
from app.routers import documents, chat, conversations, learning, mindmaps, converter

app = FastAPI(
    title="Lumina API",
    description="AI Knowledge Studio — RAG-powered PDF interaction platform",
    version="0.1.0",
)

_dev_origins = [f"http://localhost:{p}" for p in range(3000, 3010)]
_prod_origins = [
    "http://32.193.168.187",
    "https://chatwithlumina.vercel.app",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_dev_origins + _prod_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(documents.router)
app.include_router(chat.router)
app.include_router(conversations.router)
app.include_router(learning.router)
app.include_router(mindmaps.router)
app.include_router(converter.router)


@app.get("/")
def root():
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
    try:
        result = db.execute(text("SELECT 1 AS test")).scalar()
        return {"database": "connected", "test_query": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DB error: {str(e)}")