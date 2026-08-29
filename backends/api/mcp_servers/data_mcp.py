"""Data MCP (docs/ARCHITECTURE.md §1) — the Profiling & Adaptation Agent's only path to
Supabase. A local-process MCP server (stdio transport), not a direct import, so the agent's
DB access is a swappable tool boundary like every other capability in the design.

Every tool takes the caller's own bearer token and reads/writes through `rls_client(token)`
— never the service-role key — so RLS is what actually enforces "only this user's rows",
per docs/ARCHITECTURE.md §0 principles #3-4. The token travels as a plain tool argument
rather than session-level auth because one server process serves whichever user the calling
agent is currently acting for, one call at a time — there's no per-connection identity to
hang it on the way a normal user-facing API would.

Every tool returns a JSON string (`str`), not a bare `list`/`dict` — FastMCP's automatic
"structured content" varies by return-type annotation in ways that aren't safe to rely on
(a plain `dict` return isn't structured at all; `list[dict]` gets split into one text block
per item; `X | None` gets wrapped under a `"result"` key) — see the profiling_agent.py
docstring for the trace that surfaced this. A `str` return + explicit `json.dumps` here,
`json.loads` on the caller's side, sidesteps that entirely: one predictable shape, always.
"""

import json
from typing import Literal

import jwt
from mcp.server.fastmcp import FastMCP

from app.supabase_client import rls_client

mcp = FastMCP("navi-data-mcp")

Axis = Literal["motor_precision", "reading_comfort", "visual_processing_style"]


def _user_id(token: str) -> str:
    """Extracts `sub` from the token without verifying its signature — safe here because
    this value is only ever used to fill a `user_id` column on a write that ALSO goes
    through Postgres's own RLS `with check (auth.uid() = user_id)` (docs/ARCHITECTURE.md
    §0 principle #4): if this were wrong (tampered token, bug, anything), Postgres — which
    derives its own auth.uid() from the token it verified via rls_client — rejects the write
    outright. This function never gates access by itself, it only needs to match.
    """
    return str(jwt.decode(token, options={"verify_signature": False})["sub"])


@mcp.tool()
def get_evidence(token: str, axis: Axis, limit: int = 50) -> str:
    """Raw evidence_log rows for one axis, most recent first. JSON-encoded list[dict]."""
    client = rls_client(token)
    result = (
        client.table("evidence_log")
        .select("*")
        .eq("axis", axis)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return json.dumps(result.data)


@mcp.tool()
def get_capability_profile(token: str) -> str:
    """All capability_profile rows (one per axis, if scored yet). JSON-encoded list[dict]."""
    client = rls_client(token)
    data = client.table("capability_profile").select("*").execute().data
    return json.dumps(data)


@mcp.tool()
def upsert_capability_profile(token: str, axis: Axis, score: float, trend: float) -> str:
    """Writes one axis's score + trend. `unique (user_id, axis)` makes this a real upsert.
    JSON-encoded dict of the written row.

    `user_id` has no column default (docs/ARCHITECTURE.md §2's schema — deliberately, so a
    row can never exist without an explicit owner) and is `not null`, so it must be supplied
    here explicitly, same as the mobile client already does for evidence_log inserts
    (apps/mobile/lib/evidence.ts) — omitting it fails the write with a NOT NULL violation.
    """
    client = rls_client(token)
    result = (
        client.table("capability_profile")
        .upsert(
            {"user_id": _user_id(token), "axis": axis, "score": score, "trend": trend},
            on_conflict="user_id,axis",
        )
        .execute()
    )
    return json.dumps(result.data[0] if result.data else {})


@mcp.tool()
def record_accepted_adaptation(token: str, adaptation_id: str, proposed: dict) -> str:
    """Records a freshly validated proposal as this user's current accepted adaptation.
    Auto-accept model: there's no separate accept/decline UI yet, so "validated by the
    agent" and "accepted by the user" are the same event for now. This is what lets
    GET /me/adaptation (and the next run's monotonicity check) reuse a decision instead of
    re-proposing from scratch every time. JSON-encoded dict of the written row.
    """
    client = rls_client(token)
    result = (
        client.table("adaptation_feedback")
        .insert(
            {
                "user_id": _user_id(token),
                "adaptation_id": adaptation_id,
                "proposed": proposed,
                "decision": "accept",
            }
        )
        .execute()
    )
    return json.dumps(result.data[0] if result.data else {})


@mcp.tool()
def get_latest_accepted_adaptation(token: str) -> str:
    """The most recently *accepted* adaptation, for the validator's monotonicity check
    (docs/ARCHITECTURE.md §0 principle #5). JSON-encoded dict, or JSON `null` if this user
    has never accepted one.
    """
    client = rls_client(token)
    result = (
        client.table("adaptation_feedback")
        .select("proposed, decided_at")
        .eq("decision", "accept")
        .order("decided_at", desc=True)
        .limit(1)
        .execute()
    )
    return json.dumps(result.data[0]["proposed"] if result.data else None)


if __name__ == "__main__":
    mcp.run(transport="stdio")
