from typing import TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langgraph.graph import END, StateGraph

from app.llm_gateway import gateway

# Minimal system framing only — no adaptation/automation behavior lives here yet. This graph
# exists to prove the LangGraph + LLM Gateway loop end to end (docs/ARCHITECTURE.md §9 step
# 2) before the Profiling & Adaptation Agent and Task Automation Agent are wired in behind
# it via A2A (step 4 onward). The Orchestrator is the only agent that ever talks to the user
# directly (docs/ARCHITECTURE.md §1) — that stays true even as specialists are added; they'll
# be delegated to as graph nodes reached via A2A, not by growing this node's own logic.
_SYSTEM_PROMPT = (
    "Tu es Navi, un assistant d'accessibilité. Réponds brièvement et clairement, en "
    "français, sans jamais mentionner de diagnostic médical."
)


class OrchestratorState(TypedDict):
    messages: list[BaseMessage]


def _respond(state: OrchestratorState) -> OrchestratorState:
    reply = gateway.complete(state["messages"])
    return {"messages": state["messages"] + [AIMessage(content=reply)]}


_graph = StateGraph(OrchestratorState)
_graph.add_node("respond", _respond)
_graph.set_entry_point("respond")
_graph.add_edge("respond", END)
_compiled = _graph.compile()


def run_orchestrator(user_message: str) -> str:
    """Runs one turn and returns Navi's reply text.

    No conversation persistence yet (deliberately out of scope for this first increment) —
    each call is a fresh state seeded with the system prompt + the one user message.
    AllProvidersDownError from the gateway propagates uncaught; the caller (the /chat route)
    is responsible for turning that into the user-facing fallback (docs/ARCHITECTURE.md §6).
    """
    initial: OrchestratorState = {
        "messages": [SystemMessage(content=_SYSTEM_PROMPT), HumanMessage(content=user_message)]
    }
    result = _compiled.invoke(initial)
    return str(result["messages"][-1].content)
