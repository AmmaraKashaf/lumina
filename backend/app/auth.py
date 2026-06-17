"""
JWT authentication for Lumina.
Verifies Supabase-issued tokens via the JWKS endpoint (supports ECC P-256 and HS256).
"""

from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
import jwt
from jwt import PyJWKClient

from app.config import settings
from app.database import get_db
from app.models.user import User

security = HTTPBearer()

_jwks_client: PyJWKClient | None = None


def _get_jwks_client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = PyJWKClient(
            f"{settings.SUPABASE_URL}/auth/v1/.well-known/jwks.json",
            cache_keys=True,
        )
    return _jwks_client


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    """
    FastAPI dependency — decodes a Supabase JWT via JWKS and returns the matching
    User row, creating one on first login.
    """
    token = credentials.credentials

    try:
        client = _get_jwks_client()
        signing_key = client.get_signing_key_from_jwt(token)
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256", "ES256"],
            audience="authenticated",
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired — please log in again.")
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Could not validate credentials: {exc}")

    email: str = payload.get("email", "")
    if not email:
        raise HTTPException(status_code=401, detail="Token is missing email claim.")

    user = db.query(User).filter(User.email == email).first()
    if user is None:
        name = (
            payload.get("user_metadata", {}).get("full_name")
            or payload.get("user_metadata", {}).get("name")
        )
        user = User(email=email, name=name)
        db.add(user)
        db.commit()
        db.refresh(user)

    return user
