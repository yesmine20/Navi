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
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 0.0.0.0
```

`--host 0.0.0.0` (not the default `127.0.0.1`-only binding) is needed to test from the mobile
app on a physical phone via Expo Go — otherwise the phone can reach `EXPO_PUBLIC_API_URL`'s
LAN IP but nothing is listening there. If the phone still can't connect, check Windows
Firewall isn't blocking inbound connections to port 8000.

`GET /health` → `{"status": "ok"}`, no auth needed.
`GET /me/capability-profile` → requires `Authorization: Bearer <supabase access token>`,
proves the RLS round trip described in `docs/ARCHITECTURE.md` §0 principles #3-4.
`POST /chat` (`{"message": "..."}`, same bearer auth) → first working slice of the
Orchestrator (LangGraph + LLM Gateway, `docs/ARCHITECTURE.md` §9 step 2). Needs
`ANTHROPIC_API_KEY` and/or `MISTRAL_API_KEY` set — without at least one, this route (and
`POST /profile/refresh`'s proposal step) returns 503, everything else still works.
`POST /profile/refresh` → merges `evidence_log` into `capability_profile`, proposes +
validates a Layer A adaptation (`docs/ARCHITECTURE.md` §9 step 3). `204` with no body when
there's no evidence yet to reason over.

## Apply the schema

Run every file in `supabase/migrations/` (in order) against your project via the Supabase SQL
editor (dashboard) or `supabase db push` once the CLI is linked.
