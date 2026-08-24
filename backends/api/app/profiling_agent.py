"""Profiling & Adaptation Agent (docs/ARCHITECTURE.md §3 steps 3-6, §5).

Two clearly separate steps, deliberately not blurred together:
- `_merge_evidence` reduces raw `evidence_log` rows into a `capability_profile` score per
  axis. Deterministic, not an LLM call — this is summarizing the fixed mini-game telemetry
  fields into the profile's 0-1 scale, not a decision about what to do with the result. The
  actual "no hardcoded decision content" principle (docs/ARCHITECTURE.md §0.5) is about the
  adaptation choice below, not this reduction step.
- `_propose_adaptation` is the real reasoning step: the LLM sees the *whole* profile (all
  three axes + trend) at once and proposes Layer A vocabulary values with a rationale — never
  independent per-metric thresholds, per §5.

Both run inside one Data MCP session (docs/ARCHITECTURE.md §1) opened once per invocation —
the token travels as a tool argument (see mcp_servers/data_mcp.py's module docstring for why).
"""

import os
import statistics
import sys
from typing import Any, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.tools import load_mcp_tools
from langgraph.graph import END, StateGraph
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from app.adaptation_validator import validate_proposal
from app.adaptation_vocabulary import AdaptationProposal
from app.llm_gateway import gateway

AXES = ["motor_precision", "reading_comfort", "visual_processing_style"]

_SYSTEM_PROMPT = (
    "Tu es le Profiling & Adaptation Agent de Navi. On te donne le profil de capacité "
    "fonctionnelle d'un utilisateur (3 axes, score 0-1, tendance) — jamais un diagnostic, "
    "jamais une pathologie nommée. Propose des valeurs d'adaptation Layer A (police, "
    "espacement, contraste, mouvement, cibles tactiles, mode lecture) adaptées à CE profil "
    "dans son ensemble, pas axe par axe indépendamment. Un score bas = plus de friction "
    "fonctionnelle sur cet axe = adaptation plus marquée. Ta justification doit toujours "
    "référencer les axes mesurés, jamais une condition médicale."
)


class ProfilingState(TypedDict):
    token: str
    tools: dict[str, BaseTool]
    profile: list[dict[str, Any]]
    proposal: AdaptationProposal | None
    validated: AdaptationProposal | None


def _tool(state: ProfilingState, name: str) -> BaseTool:
    return state["tools"][name]


# --- Evidence -> capability_profile reduction -------------------------------------------
#
# Deliberately simple and axis-agnostic: every mini-game result already ships normalized
# 0-1-ish signals (see docs/MINI_GAMES.md — e.g. FollowThePathGame's *Norm fields,
# ReadingChallengeGame's *accuracy* fields). This just picks the handful of fields each
# game's own doc names as its clearest single accuracy/comfort signal and averages recent
# rounds — it is NOT the adaptation decision, only a reduction of raw telemetry into the
# profile's fixed 0-1 scale. Swapping this for a richer reduction later doesn't change the
# reasoning step below, since that step only ever sees the resulting score + trend.
def _score_from_evidence(axis: str, evidence_rows: list[dict[str, Any]]) -> tuple[float, float]:
    if not evidence_rows:
        return 0.5, 0.0  # unscored — neutral, not "bad"; no evidence isn't a low score

    def clamp01(x: float) -> float:
        return max(0.0, min(1.0, x))

    scores: list[float] = []
    for row in evidence_rows:
        payload = row.get("payload", {})
        if axis == "motor_precision":
            # Lower deviation = better; invert the normalized median deviation.
            dev = payload.get("pathDeviationMedianNorm")
            if dev is not None:
                scores.append(clamp01(1.0 - dev * 4))  # *4: deviation norms are typically small
        elif axis == "reading_comfort":
            acc = payload.get("readingAccuracyByWords")
            if acc is not None:
                scores.append(clamp01(acc))
        elif axis == "visual_processing_style":
            # Fast + accurate detection is a strength signal here, not a deficit (docs/
            # MINI_GAMES.md §4) — fewer misses and faster finds both push the score up.
            misses = payload.get("avgMissesPerRound")
            if misses is not None:
                scores.append(clamp01(1.0 - misses / 5))
    if not scores:
        return 0.5, 0.0

    score = statistics.mean(scores)
    if len(scores) >= 2:
        # Newest row is index 0 (evidence is fetched most-recent-first) — trend is "recent
        # minus older", so positive means improving.
        trend = scores[0] - statistics.mean(scores[1:])
    else:
        trend = 0.0
    return score, trend


async def _merge_evidence(state: ProfilingState) -> ProfilingState:
    """§0.7: a merge failure (Data MCP down, one axis's read/write erroring) must never
    surface as a crash — worst case, this run reasons over a stale-but-still-usable profile,
    or an empty one if even the read below fails, in which case `_propose_adaptation`
    proposes nothing rather than guess.
    """
    get_evidence = _tool(state, "get_evidence")
    upsert = _tool(state, "upsert_capability_profile")

    for axis in AXES:
        try:
            rows = await get_evidence.ainvoke({"token": state["token"], "axis": axis})
            if not rows:
                continue
            score, trend = _score_from_evidence(axis, rows)
            await upsert.ainvoke(
                {"token": state["token"], "axis": axis, "score": score, "trend": trend}
            )
        except Exception as exc:  # noqa: BLE001 — one axis failing must not block the rest
            print(f"[profiling_agent] evidence merge failed for axis={axis}: {exc}")

    get_profile = _tool(state, "get_capability_profile")
    try:
        profile = await get_profile.ainvoke({"token": state["token"]})
    except Exception as exc:  # noqa: BLE001 — no profile is a valid "propose nothing" case
        print(f"[profiling_agent] capability_profile read failed: {exc}")
        profile = []
    return {**state, "profile": profile}


async def _propose_adaptation(state: ProfilingState) -> ProfilingState:
    if not state["profile"]:
        # No scored axis yet (e.g. brand new user, no mini-game evidence at all) — nothing
        # to reason over. Propose nothing rather than guess (docs/ARCHITECTURE.md §0.5).
        return {**state, "proposal": None}

    profile_summary = "\n".join(
        f"- {row['axis']}: score={row['score']:.2f}, trend={row['trend']:+.2f}"
        for row in state["profile"]
    )
    messages = [
        SystemMessage(content=_SYSTEM_PROMPT),
        HumanMessage(content=f"Profil actuel:\n{profile_summary}"),
    ]
    proposal = gateway.complete_structured(messages, AdaptationProposal)
    return {**state, "proposal": proposal}


async def _validate(state: ProfilingState) -> ProfilingState:
    """Deliberately NOT wrapped in the same try/except-and-continue style as `_merge_evidence`
    — this is the hard safety gate (docs/ARCHITECTURE.md §0.5), and silently treating a failed
    fetch of the user's previous accepted adaptation as "no previous adaptation" would let a
    new proposal regress below a level they already have. A failure here should surface as a
    clear error to the caller (§0.8: nothing fails silently), not a quiet, unsafe default.
    """
    if state["proposal"] is None:
        return {**state, "validated": None}

    get_latest = _tool(state, "get_latest_accepted_adaptation")
    previous_raw = await get_latest.ainvoke({"token": state["token"]})
    previous = AdaptationProposal.model_validate(previous_raw) if previous_raw else None

    validated = validate_proposal(state["proposal"], previous)
    return {**state, "validated": validated}


_graph = StateGraph(ProfilingState)
_graph.add_node("merge_evidence", _merge_evidence)
_graph.add_node("propose_adaptation", _propose_adaptation)
_graph.add_node("validate", _validate)
_graph.set_entry_point("merge_evidence")
_graph.add_edge("merge_evidence", "propose_adaptation")
_graph.add_edge("propose_adaptation", "validate")
_graph.add_edge("validate", END)
_compiled = _graph.compile()


async def run_profiling_agent(token: str) -> AdaptationProposal | None:
    """Runs merge -> propose -> validate for the token's user, returns the validated
    proposal (or None if there's no evidence yet to reason over). Opens one Data MCP
    session, spawned as a subprocess, for the whole run.
    """
    # env must be passed explicitly: the MCP SDK spawns the subprocess with a restricted
    # default environment (not a plain inherited copy), so SUPABASE_* etc. wouldn't otherwise
    # reach app.config.settings inside the child process.
    server_params = StdioServerParameters(
        command=sys.executable, args=["-m", "mcp_servers.data_mcp"], env=dict(os.environ)
    )
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            # handle_tool_errors=False: an MCP tool error raises a ToolException instead of
            # coming back as a normal-looking result (langchain-mcp-adapters' default is to
            # return errors as a "successful" tool message so an LLM can self-correct — but
            # nothing here hands MCP results to an LLM, so a swallowed error would instead
            # silently corrupt state, e.g. `profile` becoming error-content instead of rows).
            # The try/except in _merge_evidence and _validate depend on this actually raising.
            tools_list = await load_mcp_tools(session, handle_tool_errors=False)
            tools = {t.name: t for t in tools_list}

            initial: ProfilingState = {
                "token": token,
                "tools": tools,
                "profile": [],
                "proposal": None,
                "validated": None,
            }
            result = await _compiled.ainvoke(initial)
            return result["validated"]
