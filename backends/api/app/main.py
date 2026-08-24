from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.adaptation_vocabulary import AdaptationProposal
from app.auth import AuthedUser, require_user
from app.llm_gateway import AllProvidersDownError
from app.orchestrator import run_orchestrator
from app.profiling_agent import run_profiling_agent
from app.supabase_client import rls_client

app = FastAPI(title="Navi API")

# Dev-scoped: wildcard origin is fine here because auth is bearer-token based (Authorization
# header), not cookies — there's no CSRF surface a permissive CORS policy would open up.
# Needed because Expo web (`npm run web`, e.g. localhost:8081/19006) calls this API as a
# cross-origin browser fetch, unlike the native app where CORS doesn't apply at all.
# Tighten to explicit origins before this ever ships past local development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/me/capability-profile")
def get_capability_profile(user: AuthedUser = Depends(require_user)) -> list[dict]:
    """Proves the auth → RLS round trip: only rows where user_id = auth.uid() come back,
    enforced by Postgres, not by this endpoint filtering in Python.
    """
    client = rls_client(user.token)
    result = client.table("capability_profile").select("*").execute()
    return result.data


class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    reply: str


@app.post("/chat")
def chat(body: ChatRequest, user: AuthedUser = Depends(require_user)) -> ChatResponse:
    """First working slice of Workflow B (docs/ARCHITECTURE.md §4): text in, Orchestrator
    reply out. Requires auth like every other route (§0 principle #3) even though the
    Orchestrator doesn't touch user data yet — it will once specialists are wired in via A2A.
    """
    try:
        reply = run_orchestrator(body.message)
    except AllProvidersDownError:
        # §6: "no new response is generated" — a clear 503, never a guessed reply.
        raise HTTPException(
            status_code=503,
            detail="Navi n'est pas disponible pour le moment. Réessaie dans un instant.",
        )
    return ChatResponse(reply=reply)


@app.post("/profile/refresh")
async def refresh_profile(
    response: Response, user: AuthedUser = Depends(require_user)
) -> AdaptationProposal | None:
    """Workflow A steps 4-6 (docs/ARCHITECTURE.md §3): merges this user's evidence_log into
    capability_profile, proposes an adaptation, runs it through the hard validator.

    Synchronous for now — the mobile app calls this after finishing a mini-game (or anytime)
    and shows NaviAdaptationPrompt with whatever comes back. §0.7's "background merge never
    raises" is honored one level down (the merge step itself never surfaces a partial
    failure as a 500 — it either has evidence to reduce or it doesn't); a genuine LLM/provider
    outage during the *proposal* step is a real "nothing to show right now" case, not
    something to paper over, so it's reported as 503 like /chat.

    204 (no body) when there's no evidence yet to reason over, rather than a null/empty
    AdaptationProposal — no adaptation *content* exists until there's something to base it on.
    """
    try:
        validated = await run_profiling_agent(user.token)
    except AllProvidersDownError:
        raise HTTPException(
            status_code=503,
            detail="Navi n'est pas disponible pour le moment. Réessaie dans un instant.",
        )
    if validated is None:
        response.status_code = 204
        return None
    return validated
