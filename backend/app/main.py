from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Create the FastAPI application instance
app = FastAPI(
    title="Lumina API",
    description="AI Knowledge Studio — RAG-powered PDF interaction platform",
    version="0.1.0",
)

# Allow our Next.js frontend to talk to this backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    """Health check endpoint — confirms the API is running."""
    return {
        "service": "Lumina API",
        "status": "online",
        "version": "0.1.0",
    }


@app.get("/health")
def health():
    """Detailed health endpoint for monitoring."""
    return {"status": "healthy"}