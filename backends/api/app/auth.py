from functools import lru_cache

import jwt
from fastapi import Header, HTTPException
from pydantic import BaseModel

from app.config import settings


class AuthedUser(BaseModel):
    user_id: str
    token: str


@lru_cache(maxsize=1)
def _jwks_client() -> jwt.PyJWKClient:
    # Cached (module-level, one process): PyJWKClient itself also caches the fetched keys, but
    # this avoids rebuilding the client (and its cache) on every single request.
    return jwt.PyJWKClient(f"{settings.supabase_url}/auth/v1/.well-known/jwks.json")


def require_user(authorization: str = Header(...)) -> AuthedUser:
    """Verifies the bearer token and returns the caller's user_id + raw token.

    user_id NEVER comes from anywhere else (request body, query param) — this is the
    only source of truth for "who is calling", per docs/ARCHITECTURE.md §0 principle #3.

    Two verification paths, chosen by what's configured — Supabase projects created before
    the platform's move to per-project asymmetric signing keys issue HS256 tokens signed
    with a static secret (SUPABASE_JWT_SECRET, from the dashboard); newer projects (like this
    one — confirmed via its /auth/v1/.well-known/jwks.json, which returns an ES256 key) sign
    with a private key and publish the public half at that JWKS endpoint instead. There is no
    shared secret to configure for the second case; verification uses the public key fetched
    from JWKS, matched by the token's `kid` header, entirely locally after that fetch — no
    per-request call to Supabase, so this stays "local JWT" in the sense docs/ARCHITECTURE.md
    §7 means (fast, no round trip), not a fallback to calling the Supabase Auth API.
    """
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Missing or malformed bearer token")

    try:
        if settings.supabase_jwt_secret:
            claims = jwt.decode(
                token, settings.supabase_jwt_secret, algorithms=["HS256"], audience="authenticated"
            )
        else:
            signing_key = _jwks_client().get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token, signing_key.key, algorithms=["ES256"], audience="authenticated"
            )
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    return AuthedUser(user_id=claims["sub"], token=token)
