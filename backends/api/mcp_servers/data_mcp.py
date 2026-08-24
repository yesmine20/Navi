"""Data MCP (docs/ARCHITECTURE.md §1) — the Profiling & Adaptation Agent's only path to
Supabase. A local-process MCP server (stdio transport), not a direct import, so the agent's
DB access is a swappable tool boundary like every other capability in the design.

Every tool takes the caller's own bearer token and reads/writes through `rls_client(token)`
— never the service-role key — so RLS is what actually enforces "only this user's rows",
per docs/ARCHITECTURE.md §0 principles #3-4. The token travels as a plain tool argument
rather than session-level auth because one server process serves whichever user the calling
agent is currently acting for, one call at a time — there's no per-connection identity to
hang it on the way a normal user-facing API would.
"""

from typing import Literal

from mcp.server.fastmcp import FastMCP

from app.supabase_client import rls_client

mcp = FastMCP("navi-data-mcp")

Axis = Literal["motor_precision", "reading_comfort", "visual_processing_style"]


@mcp.tool()
def get_evidence(token: str, axis: Axis, limit: int = 50) -> list[dict]:
    """Raw evidence_log rows for one axis, most recent first."""
    client = rls_client(token)
    result = (
        client.table("evidence_log")
        .select("*")
        .eq("axis", axis)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data


@mcp.tool()
def get_capability_profile(token: str) -> list[dict]:
    """All capability_profile rows (one per axis, if scored yet) for the caller."""
    client = rls_client(token)
    return client.table("capability_profile").select("*").execute().data


@mcp.tool()
def upsert_capability_profile(token: str, axis: Axis, score: float, trend: float) -> dict:
    """Writes one axis's score + trend. `unique (user_id, axis)` makes this a real upsert."""
    client = rls_client(token)
    result = (
        client.table("capability_profile")
        .upsert(
            {"axis": axis, "score": score, "trend": trend},
            on_conflict="user_id,axis",
        )
        .execute()
    )
    return result.data[0] if result.data else {}


@mcp.tool()
def get_latest_accepted_adaptation(token: str) -> dict | None:
    """The most recently *accepted* adaptation, for the validator's monotonicity check
    (docs/ARCHITECTURE.md §0 principle #5) — None if this user has never accepted one."""
    client = rls_client(token)
    result = (
        client.table("adaptation_feedback")
        .select("proposed, decided_at")
        .eq("decision", "accept")
        .order("decided_at", desc=True)
        .limit(1)
        .execute()
    )
    return result.data[0]["proposed"] if result.data else None


if __name__ == "__main__":
    mcp.run(transport="stdio")
