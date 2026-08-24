# Navi v2 — Architecture

Status: pre-implementation reference. This is the converged design from architecture
discussion — component map, both end-to-end workflows, every fallback path, the security
boundary, what still needs outside research, and the phased build plan. Nothing here is
code yet; this is what the code will follow.

---

## 0. Non-negotiable principles

These aren't style preferences — each removes a real failure mode. Nothing below should be
implemented in a way that routes around them.

1. **Consent is two-layer.** Every adaptation and every automated action is proposed, never
   imposed, unless the user has explicitly opted into an auto mode. The server never applies
   an adaptation without a stored acceptance record.
2. **No diagnosis.** The system infers *functional capability*, never a medical condition.
   No field anywhere stores "Parkinson's" or "dyslexia" — only measurable axes (motor
   precision, reading comfort, visual processing style — see `MINI_GAMES.md`). This is a
   product and legal boundary, not just an ethical one — it's what keeps this out of
   medical-device territory.
3. **`user_id` always comes from a verified token, never the request body.** A client-supplied
   user_id would let anyone read or write anyone else's profile.
4. **RLS enforced via the caller's own token for every read.** The service-role key exists
   only for server-initiated writes (e.g. rollups), never for reads.
5. **Safety boundaries are deterministic code; decision content never is.** Monotonicity
   (adaptations only ever make things easier), the offered-selector whitelist, and
   `FORBIDDEN_HIDE` are fixed validators that run *after* any agent reasoning and can reject
   it — they're a structural contract, not a judgment call, so they don't belong to the LLM.
   But no adaptation *content* (which change to propose, what default to fall back to) is
   ever hardcoded — that's what made the old threshold-based engine feel wrong, and it's why
   the down-path in §5/§6 proposes nothing rather than a canned default.
6. **The browser action vocabulary is closed and validated.** An unrecognized or malformed
   action degrades to `ask`, never a crash, never a best-effort guess.
7. **Background evidence merges never raise.** They run after the HTTP response is already
   sent — a failure there must cost the user nothing.
8. **Nothing fails silently.** Every network or model boundary (LLM provider, STT, TTS, A2A
   call, MCP call) has an explicit, observable fallback — see §6.

---

## 1. Component map

```
┌─────────────────────────── Mobile app (Expo / React Native) ───────────────────────────┐
│  Auth screen · 4 tabs · WebView browser · mini-games · voice I/O (mic capture, TTS out)  │
│  Local capability cache · sync queue (buffers evidence/feedback while offline)           │
└───────────────────────────────────────┬──────────────────────────────────────────────────┘
                                         │ HTTPS + WebSocket (bearer token)
┌────────────────────────────────────────▼──────────────────────────────────────────────────┐
│                             Backend — single FastAPI process (:8000)                       │
│                                                                                              │
│   Auth boundary (token verify, RLS-scoped Supabase client)                                 │
│                                                                                              │
│   ┌─────────────────────────┐                                                              │
│   │  Orchestrator Agent      │  user-facing loop (LangGraph). Holds conversation state,    │
│   │  (LangGraph)             │  routes to specialists via A2A, never touches DB/browser    │
│   └────────────┬─────────────┘  directly.                                                  │
│                 │ A2A (task request / status / result)                                     │
│        ┌────────┴─────────┐                                                                │
│        ▼                  ▼                                                                │
│  ┌───────────────┐  ┌──────────────────┐                                                   │
│  │ Profiling &   │  │ Task Automation   │   both are LangGraph graphs, each with          │
│  │ Adaptation    │  │ Agent             │   its own A2A Agent Card + endpoint              │
│  │ Agent         │  │ (intent/feasibility│                                                  │
│  │               │  │  + browser planner)│                                                  │
│  └──────┬────────┘  └─────────┬─────────┘                                                  │
│         │ MCP                 │ MCP                                                         │
│   ┌─────┴──────┐      ┌───────┴────────┐    ┌─────────────┐    ┌──────────────┐          │
│   │ Data MCP   │      │ Browser Bridge │    │ Scanner MCP │    │ Web Reader   │          │
│   │ (Supabase) │      │ MCP (↔ mobile  │    │ (Pixtral    │    │ MCP (page    │          │
│   │            │      │  WebView, live │    │  OCR)       │    │  analyzer)   │          │
│   │            │      │  WebSocket)    │    │             │    │              │          │
│   └────────────┘      └────────────────┘    └─────────────┘    └──────────────┘          │
│                                                                                              │
│   LLM Gateway (multi-provider, circuit breaker) — the model layer every graph node calls   │
│   LangSmith — traces every graph run across both specialists and the orchestrator          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                              Supabase (Auth + Postgres/RLS)
```

**Why an Orchestrator + 2 specialists over A2A, instead of one flat set of functions:**
the Profiling/Adaptation agent and the Task Automation agent have genuinely separate
authority (one decides UI changes, the other decides browser actions) and separate
lifecycles — this is the real case for A2A's task-delegation model, not protocol for its
own sake.

**Why MCP for tool access:** every capability an agent needs (DB, browser control, OCR, page
reading) is exposed as a standard tool/resource interface instead of being imported directly,
so any agent can be given any tool without new plumbing each time, and `langchain-mcp-adapters`
binds them straight into LangGraph nodes.

---

## 2. Data model (Supabase)

The original project used 3 tables. This design adds a 4th, deliberately — the learning loop
in §5 needs somewhere to store the accept/decline signal, and that's a distinct concern from
the evidence that produced the proposal in the first place.

| Table | Purpose | Written by |
|---|---|---|
| `capability_profile` | One row per user per axis (motor precision, reading comfort, visual processing style) — current score + trend. No condition/diagnosis field, ever. | Profiling & Adaptation Agent (via Data MCP) |
| `evidence_log` | Raw evidence events: game telemetry, on-device passive signals, conversation-derived signals. Append-only. | Mobile (sync queue) + Orchestrator |
| `adaptation_feedback` | One row per event (accept / decline / revert) on a proposed adaptation, linked by `adaptation_id` so a later revert joins back to its accept. This is the bandit's reward signal. | Mobile, on every consent-prompt interaction |
| *(Auth)* `auth.users` | Supabase-managed, not custom. | Supabase Auth |

RLS: every table readable only via `as_user(token)`. Writes from the mobile app go through
the same RLS-scoped client; only server-initiated rollups (e.g. recomputing a trend) use the
service-role key.

---

## 3. Workflow A — Onboarding → profiling → adaptation

1. Sign in / sign up (email + password) → Supabase Auth issues a token.
2. First authenticated session → mobile presents the 3 mini-games (1 game per capability
   axis — motor precision, reading comfort, visual processing style. Mapping locked in
   `MINI_GAMES.md`: Follow the Path / Reading Challenge / Pattern Detective).
3. Each game session produces telemetry → written to `evidence_log` (queued locally first if
   offline, flushed by the sync queue on reconnect).
4. Backend: Profiling & Adaptation Agent (LangGraph, via Data MCP) merges evidence into
   `capability_profile` — background job, never raises (principle §0.7).
5. Same agent reasons over the full profile (not per-metric thresholds) and proposes an
   adaptation, in structured output.
6. Hard validator runs against the proposal: monotonicity, offered-selector whitelist,
   `FORBIDDEN_HIDE`. Only validator-approved proposals ever reach the user.
7. Mobile shows `NaviAdaptationPrompt`. User accepts / declines / later reverts.
8. That decision is written to `adaptation_feedback` — this is what the bandit layer (§5)
   trains on.

---

## 4. Workflow B — Voice automation

1. Wake word / mic tap → on-device capture.
2. STT → text (e.g. *"va sur YouTube, ouvre-moi la chanson la vie est belle"*).
3. Text → Orchestrator Agent.
4. Orchestrator delegates to the Task Automation Agent via A2A with the request as a task.
5. Task Automation Agent: intent + feasibility classification first (`direct_navigation` /
   `specific_task` / `vague_task` / `unclear` — unclear or infeasible returns to the
   Orchestrator with an explanation, never silently proceeds).
6. If feasible: the agent plans one action at a time (`navigate`, `type`, `submit`, `click`,
   `wait`, …) and calls the **Browser Bridge MCP** tool for each action.
7. Browser Bridge MCP relays the action to the mobile app's live WebSocket session, the
   mobile app executes it against the WebView, and reports the resulting state back — this
   round trip repeats until the agent emits `done` (or `ask`, if something doesn't match the
   closed action vocabulary).
8. Task Automation Agent returns a result to the Orchestrator via A2A.
9. Orchestrator replies to the user in text **and** TTS.

---

## 5. Adaptation decision & learning loop

- **Primary decision:** the Profiling & Adaptation Agent (LangGraph node, LLM-backed) reasons
  over the full profile — not independent per-metric thresholds — and proposes an adaptation
  with a stated rationale.
- **Hard safety gate:** a deterministic validator (plain code, no LLM) checks monotonicity,
  the offered-selector whitelist, and `FORBIDDEN_HIDE` before anything reaches the user. This
  is the one piece that must be simple, tested, and boring.
- **Learning:** every accept/decline/revert (`adaptation_feedback`) feeds a **contextual
  bandit** — not a full RL policy. The bandit only ever chooses among validator-approved
  candidates; it personalizes *which* safe adaptation to lead with, never *whether* something
  is safe. This is deliberately scoped to the data volume an early product actually has.
- **Fallback when the reasoning path itself is down** (LLM outage, all providers circuit-broken):
  no new adaptation is proposed. Existing UI state is left exactly as it is — "do nothing" is
  itself a safe state, and it needs no pre-decided adaptation value sitting in code. There is
  no hardcoded decision content anywhere in this path; the system just resumes proposing once
  a provider recovers.
- **Observability:** LangSmith traces every run of every graph — what evidence went in, what
  the LLM reasoned, what the validator approved or rejected, what the user did. This is the
  direct answer to "the old adaptation didn't feel right" — you can't tune what you can't see.

---

## 6. Fallback chains

| Failure point | Fallback behavior |
|---|---|
| LLM provider fails | Gateway circuit breaker (3 failures → 45s cooldown) routes to the next configured provider. If all providers are down, no new adaptation/response is generated — existing UI state is left untouched, never partially changed. |
| STT unavailable | Falls back to a text input field — command entry never hard-blocks on voice. |
| TTS unavailable | Falls back to text-only display of the same response — the answer is never lost, just not spoken. |
| Planner emits an unrecognized action | Degrades to `ask`, surfaced to the user as a question, never a crash or a guess. |
| Browser Bridge loses the mobile WebSocket mid-task (app backgrounded, network drop) | Task is marked paused/cancelled explicitly; user is told the automation stopped. No orphaned action is left assumed-executed. |
| A2A specialist agent unreachable/times out | Orchestrator catches it and tells the user that automation or profiling is temporarily unavailable, instead of hanging. |
| Background evidence merge throws | Logged only, never surfaced to the user, never blocks the response that triggered it (principle §0.7). |
| Adaptation reasoning path fully down | No new adaptation proposed; existing UI state preserved untouched — same behavior as an LLM provider outage, deliberately not a separate hardcoded path (§5). |
| Mobile fully offline | Local sync queue buffers evidence and feedback events, replays them on reconnect — nothing is silently dropped. |

---

## 7. Security boundary (recap, unchanged from the original design)

- `user_id` only from a verified token (local JWT if `SUPABASE_JWT_SECRET` is set, else a
  Supabase Auth API call) — never from the request body.
- Reads always go through `as_user(token)` (RLS-scoped); the service-role key is reserved for
  server-initiated writes only.
- `sanitize_adaptation(offered=…)` — the server may only select from selectors the client
  itself offered, for its own screens.
- `FORBIDDEN_HIDE` — structural elements can never be hidden by an adaptation.
- Browser action vocabulary is a closed, validated set.

---

## 8. What needs outside research before/while building

- **A2A protocol** — read the spec and Google's reference samples (agent card format, task
  lifecycle, streaming updates) to design the adapter layer that exposes a LangGraph app as
  an A2A-reachable agent; no framework here does this for you automatically.
- **MCP remote transport (Streamable HTTP)** — needed specifically for the Browser Bridge
  server, since it isn't a local-process tool server like most MCP examples; it has to hold a
  live session tied to one connected phone.
- **`langchain-mcp-adapters`** — current API for binding MCP tool servers into LangGraph
  nodes.
- **Contextual bandit implementation** — either a small library (e.g. Vowpal Wabbit) or a
  hand-rolled Thompson sampling / epsilon-greedy approach sized for a small user base; decide
  before Workflow A's step 6 is built for real.
- **LangSmith** — usage limits/pricing on a personal account, and how tracing is scoped per
  project/environment.
- **Expo WebView bridge** — `injectedJavaScript` / `onMessage` APIs, since the Browser Bridge
  MCP server's "execute this action" round trip depends on this exact mechanism.
- **STT/TTS provider choice** — on-device vs API tradeoff (latency, offline capability, cost,
  voice quality) — still open from earlier discussion.
- ~~**Ad/clutter detection approach**~~ → resolved, see `THIRD_PARTY_ADAPTATION.md` §3:
  staged heuristic pass (EasyList-derived domain/pattern matching) first, Scanner MCP vision
  confirmation only for medium/low-confidence candidates second.

---

## 9. Phased build plan

Revised 2026-08-23: the product goal is adapting arbitrary third-party pages, not just
Navi's own screens, so that work is pulled into the main sequence instead of deferred as
"Phase 2" — see `THIRD_PARTY_ADAPTATION.md` for the full design (adaptation vocabulary,
declutter classification pipeline, generalized safety boundary) that step 5 onward builds
against.

1. **Data layer + auth** — 3+1 table schema, token verification. **Done.**
2. **Orchestrator + LLM gateway** — one provider wired through LangGraph, a working
   conversational loop, before anything agentic or adaptive.
3. **Data MCP + Profiling & Adaptation Agent**, proven against the 3 mini-games already
   producing real `evidence_log` rows. Prove the propose → validate → consent loop end to
   end, including the hard validator — built from the start as the generic adaptation
   vocabulary validator (`THIRD_PARTY_ADAPTATION.md` §2), not a Navi-screens-only selector
   whitelist, since that intermediate step is intentionally being skipped.
4. **A2A wiring** between Orchestrator and the Profiling agent — the simplest possible
   delegation, to prove the protocol layer before adding a second specialist.
5. **WebView screen + Browser Bridge MCP** — the injection surface. One page loading and one
   round trip working end to end before anything is applied to it.
6. **Layer A — generic styling adaptations** (`THIRD_PARTY_ADAPTATION.md` §2) applied end to
   end on real third-party pages. This is the first real "adapts any site" result, and has
   no detection dependency, so it's the fastest path to something demonstrably working.
7. **Web Reader MCP + Scanner MCP** — main-content extraction and vision classification,
   the prerequisites for decluttering, built once Layer A is validated.
8. **Layer B — decluttering** (`THIRD_PARTY_ADAPTATION.md` §3-4): heuristic pass, vision
   pass, confidence gating, consent flow. The highest-risk piece, deliberately built last
   and on top of a working Layer A + main-content protection.
9. **Task Automation Agent** (voice-driven browser actions — navigate/click/type) — reuses
   the Browser Bridge MCP built in step 5, but is a separate specialist/authority (§0) from
   the adaptation work above.
10. **Voice (STT in, TTS out)** — layered on last; it's the most bespoke, highest-testing-cost
    piece per the original spec, and shouldn't block the core loop.
11. **Contextual bandit** — only once `adaptation_feedback` has real accumulated data from
    the steps above actually being used.

---

## 10. On "guaranteeing" solidity

Worth being precise about what can actually be promised. No one can honestly guarantee zero
bugs before a line of code exists. What this design does commit to, concretely:

- Safety *boundaries* (what's allowed to change in the UI, what actions are attemptable in
  the browser) are owned by deterministic, testable code — never left to an LLM's judgment
  call. Decision *content* (which adaptation, which action) is never hardcoded, including in
  failure paths — when the reasoning system is down, the fallback is to propose nothing, not
  a canned answer.
- Every network or model boundary has a named, explicit fallback (§6) — nothing is allowed
  to hang or fail silently.
- The consent gate is structural: the server holds no path that applies an adaptation
  without a stored acceptance record, short of the user explicitly opting into auto mode.
- Every agent decision is traced (LangSmith), so when something looks wrong, it's
  diagnosable from evidence in → reasoning → validator outcome, not a guess.
- Complexity is staged — the bandit, vision planning, and third-party-page adaptation only
  get built once the layer beneath them is proven under real use, not in parallel with it.

That combination is what "solid" means in engineering terms here: not the absence of bugs,
but no failure mode that's silent, unbounded, or unsafe.
