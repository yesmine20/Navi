# Navi API (FastAPI)

## Setup

```
py -3.13 -m venv .venv
.venv\Scripts\python.exe -m pip install -e .
```

Copy `.env.example` to `.env` and fill in the values from your Supabase project
(Project Settings → API, and → API → JWT Settings for the JWT secret).

## Run

```
.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

`GET /health` → `{"status": "ok"}`, no auth needed.
`GET /me/capability-profile` → requires `Authorization: Bearer <supabase access token>`,
proves the RLS round trip described in `docs/ARCHITECTURE.md` §0 principles #3-4.
`POST /chat` (`{"message": "..."}`, same bearer auth) → first working slice of the
Orchestrator (LangGraph + LLM Gateway, `docs/ARCHITECTURE.md` §9 step 2). Needs
`ANTHROPIC_API_KEY` set — without it this route returns 503, everything else still works.

## Apply the schema

Run `supabase/migrations/0001_init.sql` against your project via the Supabase SQL editor
(dashboard) or `supabase db push` once the CLI is linked.
