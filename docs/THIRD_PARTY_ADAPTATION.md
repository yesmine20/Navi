# Navi v2 — Adapting third-party pages (was "Phase 2" in ARCHITECTURE.md)

Status: pre-implementation design, resolves the two open items `ARCHITECTURE.md` §8 flagged
as needing outside research before building ("ad/clutter detection approach", generalized
adaptation vocabulary). Promoted from "Phase 2, deferred" to in-scope by product decision
(2026-08-23): the actual goal is adapting arbitrary sites, not just Navi's own screens, so
this is built alongside the core agent loop instead of after it. `ARCHITECTURE.md` §9 and
`CADRAGE.md` §2/§7 are updated to match.

Why this needs its own doc instead of just extending the existing adaptation flow: Workflow A
(§3 of `ARCHITECTURE.md`) assumes the client can offer a whitelist of known selectors up
front (`sanitize_adaptation(offered=…)`, §7). That assumption is false for a page Navi has
never seen before. Everything below is what replaces it for that case — same principles
(§0), different mechanism.

---

## 1. Two adaptation layers, deliberately kept separate

| | Layer A — generic styling | Layer B — decluttering |
|---|---|---|
| What it does | Font size, line/letter spacing, contrast, motion, touch-target size, reading mode | Hides specific elements (ads, popups, distraction) |
| Needs page understanding? | No — pure CSS/JS, DOM-agnostic | Yes — has to classify *this* page's elements |
| Risk if wrong | Ugly, never breaks function | Could hide real content — the actual danger |
| Ships behind | Standard consent flow (§0.1) | Consent flow + confidence gate (§4) |

Layer A is buildable immediately with no detection problem at all — it's a closed set of CSS
custom properties applied globally, the same for every site. Layer B is the hard, genuinely
risky part, and gets its own safety mechanism below rather than reusing `FORBIDDEN_HIDE`
as-is (that list is fixed selectors on *known* screens; it has no meaning on a DOM Navi has
never seen).

**Where the site-adaptive intelligence actually lives — read this before §5.** §5 below
says the injected applier script is *fixed*, never LLM-generated. That's not a contradiction
with "adapts any site" — it's the reason it's safe to do so. The applier is the *hands*: it
knows exactly three universal, mechanical moves (write a `<style>` from given values, add/
remove a class on given element ids, extract a generic DOM summary) — the same three moves
regardless of which site is loaded, because CSS/DOM operations are already universal to the
web platform. It never has to "understand" a site to do them.

The *site-specific* decision — which values, which elements — is made fresh, every time, by
the agent/MCP layer, which does look at the current page:
- Layer A doesn't even need to: the agent only ever looks at `capability_profile` (the
  user), computes fontScale/contrastMode/etc. **once**, and those values apply identically
  everywhere because the CSS properties themselves are universal — that's *why* Layer A
  needs no per-site logic at all.
- Layer B genuinely re-analyzes **the page currently loaded**, every load: the heuristic
  pass runs on that page's extracted DOM summary, the vision pass (Scanner MCP) looks at a
  screenshot of that page, Web Reader MCP finds that page's main content. The output (which
  element ids to hide) is different for every site and recomputed every time — only the
  mechanical "hide these ids" gesture that executes it is fixed.

---

## 2. Layer A — generic adaptation vocabulary (closed, like the browser action vocabulary in §0.6)

The Profiling & Adaptation Agent reasons over `capability_profile` and outputs values from
this fixed set — never arbitrary CSS, never a selector it invented:

```
fontScale        1.0 – 1.8         (motor_precision, reading_comfort)
lineSpacing      normal|relaxed|loose            (reading_comfort)
letterSpacing    normal|wide                     (reading_comfort)
contrastMode     none|high|dark                  (reading_comfort, visual_processing_style)
reduceMotion     bool                             (motor_precision, visual_processing_style)
touchTargetBoost bool  (min 44px hit targets, extra spacing between tappable elements)   (motor_precision)
readingMode      bool  (Readability-style extraction: strip layout, single-column, chosen font/spacing)   (reading_comfort)
```

- **Deterministic validator** (plain code, no LLM — same split as §0.5): clamps every value
  to its declared range (e.g. `fontScale` can never exceed 1.8 regardless of what the agent
  outputs), enforces monotonicity (an accepted adaptation only ever moves toward *more*
  accessible, never less, session over session), and rejects any key not in the vocabulary
  above. This validator is shared code — it's the exact same shape whether the target is a
  Navi screen or a third-party page, just without a selector whitelist to also check.
- **Application mechanism**: a fixed, audited JS payload (shipped in the app, never
  LLM-generated) reads the validated vocabulary values and injects one `<style>` tag + a
  small `MutationObserver` (so it still applies to content the page adds later, e.g.
  infinite scroll) via the WebView's `injectedJavaScript`. The agent never emits executable
  code — only vocabulary + parameters, exactly mirroring §0.6's "closed browser action
  vocabulary, LLM never emits raw code."
- `readingMode` is the one non-trivial case: it needs Web Reader MCP's main-content
  extraction (already planned in `ARCHITECTURE.md` §1) to know which DOM subtree *is* the
  article/content before it can rebuild the page as single-column text. Same MCP server
  layer B's main-content detection depends on (§3) — one extraction, two consumers.

This layer alone is a real, shippable "adapts any site" result and has no ad/clutter
detection dependency — it can go first even within the "straight to third-party sites"
build order.

---

## 3. Layer B — decluttering: classification pipeline

Two passes, cheap-first, expensive-only-when-needed — this is the resolution to the
"heuristic vs. vision" question `ARCHITECTURE.md` §8 left open. Answer: **both, staged**,
not one or the other.

1. **Heuristic pass (always runs, no LLM/vision cost).** Deterministic code, not agent
   reasoning:
   - iframe/script `src` host matches a maintained ad/tracker domain list (EasyList-derived
     — start with a small curated subset of the most common networks, e.g. doubleclick.net,
     googlesyndication.com, taboola.com, outbrain.com; expand from real usage data later,
     never hand-wave "the full list" as v1 scope).
   - class/id matches high-confidence ad/consent patterns (`/^ad[-_]/i`, `/sponsor/i`,
     `/cookie[-_]?consent/i`, `/gdpr/i` on elements that are also fixed/sticky-positioned).
   - structural: `position: fixed|sticky` element covering more than ~40% of viewport area,
     with a z-index above the page's median — classic interstitial/popup signature.
   - Each match gets a **confidence score** (exact domain-list match = high; class/id
     regex alone = medium; structural-only = low).
2. **Vision pass (Scanner MCP / Pixtral OCR), only for medium/low-confidence candidates**,
   not run on every element on every page — cost and latency scoped to the ambiguous
   fraction only. Confirms/rejects: does this screenshot region read as an ad/banner/consent
   overlay vs. real content. Promotes medium→high or demotes to "leave alone."
3. **Main-content protection (Web Reader MCP).** Before anything is even eligible for
   hiding, the main-content extraction runs first and marks its subtree as protected —
   regardless of confidence score, nothing inside the detected article/content region is
   ever a hide candidate. This is the generalized `FORBIDDEN_HIDE`: not a fixed selector
   list (impossible on an unbounded DOM), but a structural rule — *never hide inside the
   region Web Reader MCP identifies as the page's own content* — plus absolute floors that
   apply everywhere: never hide anything containing a `<form>`, a non-ad-classified
   `<button>`/`<input>`, or a `<nav>`/`role="navigation"` landmark.

Only **high-confidence** candidates (post both passes) are eligible for the consent/gate
step in §4. Medium/low stay visible — a missed ad is a far better failure mode than a hidden
real element, and that asymmetry is deliberate, not a tuning oversight to fix later.

---

## 4. Consent gate for Layer B specifically

Layer A adaptations use the existing two-layer consent flow as-is (§0.1). Layer B gets a
stricter default because the failure mode is worse (hiding real content vs. an ugly font):

- **First encounter of a given hide-candidate pattern** (by domain + element signature, not
  per-page — so it generalizes across visits to the same site/ad network): shown collapsed
  with a visible "masquer ce type d'élément sur ce site ?" affordance, not silently
  auto-hidden. This is a UX/product call, not a technical constraint — flagging it as a
  default I'm choosing, not a settled decision; happy to revisit once there's real
  `adaptation_feedback` data.
- Every hide is **reversible by construction**: `display:none` is never used; hidden
  elements collapse via a class the applier script controls, and the WebView surfaces an
  always-available "afficher les éléments masqués" toggle per page.
- Accept/decline on a hide-candidate pattern writes to `adaptation_feedback` exactly like
  today (`adaptation_id` scoped to the pattern, not the individual DOM node) — this is what
  lets the bandit (§5 of `ARCHITECTURE.md`) eventually skip the confirm step for
  patterns this specific user has already trusted repeatedly, without that ever becoming a
  silent default for other users.

---

## 5. The WebView bridge — how a change actually lands on the page

Everything in §2-4 describes *what* to apply and *when it's safe*. This is *how* it reaches
the page, concretely, with `react-native-webview` (Expo) as the mechanism:

- **`injectJavaScript(script)`** (called on a WebView ref from React Native) runs arbitrary
  JS inside the loaded page's context, on demand.
- **`window.ReactNativeWebView.postMessage(json)`** inside the page + the WebView's
  `onMessage` prop is the return channel — the only way data gets *out* of the page back to
  the app, since the backend/agent never has direct access to a live DOM running on the
  phone.
- The script run by `injectJavaScript` is a **fixed file shipped in the app**, never
  LLM-generated — it accepts parameters (vocabulary values, or a hide-list) and applies
  them. This is what makes §0.6's "closed vocabulary in, fixed code out" contract concrete:
  the agent's output is JSON parameters, not executable code.

**Layer A — no round trip during browsing:**
1. On WebView mount, the app reads `capability_profile` from the local cache (already part
   of the mobile component per `ARCHITECTURE.md` §1 — no network call needed to browse).
2. `injectJavaScript(applier, {fontScale, lineSpacing, contrastMode, reduceMotion,
   touchTargetBoost, readingMode})` — the applier writes/updates a single
   `<style id="navi-adaptation">` tag and installs a `MutationObserver` on `document.body`
   so content added later (infinite scroll, SPA route changes) still matches the same CSS
   rules. Instant, works offline, no classification involved.

**Layer B — one round trip per page load:**
1. The applier script tags each heuristic-pass candidate (§3) with a stable
   `data-navi-id="…"` attribute — not a CSS selector, which could match the wrong element
   on a page that changes between the extraction and the apply step — and extracts a
   lightweight summary per candidate (tag, class/id, iframe `src`, bounding box, computed
   `position`/`z-index`). `postMessage`s that summary array to the app.
2. The app forwards it to the backend. Medium/low-confidence candidates that need the
   vision pass get one additional round trip: the app captures the WebView visually via
   `react-native-view-shot`'s `captureRef` (not a `react-native-webview` API — a separate
   library, since the WebView component has no built-in screenshot method) and sends that
   image alongside the candidate list to Scanner MCP.
3. Backend returns the `data-navi-id` values cleared for hiding (§3-4 confidence gate).
4. `injectJavaScript(applier, {hide: [...ids]})` — the applier adds a `navi-hidden` class
   (never an inline `display:none`, so a later "show hidden elements" toggle is a pure CSS
   class removal, not a re-run of classification) to the matching elements.

Layer A and Layer B use the *same* applier script file with different parameter shapes —
one injection mechanism, not two.

---

## 6. Security boundary specific to arbitrary third-party pages

Generalizes `ARCHITECTURE.md` §7, which was written assuming known app screens:

- The applier script's capability surface is fixed and audited: style injection + element
  collapse/restore only. It is never given `eval`, form submission, navigation, or storage
  access — the same closed-vocabulary-in, fixed-code-out shape as the browser action
  vocabulary (§0.6), so an LLM output can never become arbitrary page-context JS.
- Never reads form field **values**, never touches `<input type="password">` or anything in
  a password-manager-flagged field, never reads cookies/localStorage of the loaded page.
  Classification (§3) works off DOM structure and rendered screenshots only.
- A small denylist of sensitive domain patterns (banking, payment, government auth) ships
  with Layer B disabled entirely on match — Layer A (generic styling) still applies, since
  it can't hide anything, but decluttering does not run there at all until this has a lot
  more real-world validation behind it.
- Everything Layer B does — every classification, confidence score, and hide/show action —
  goes through LangSmith tracing like every other agent decision (§0's observability
  principle), specifically because "did the classifier just hide something it shouldn't
  have" is the one failure mode here that's genuinely hard to catch any other way.

---

## 7. What this changes in the existing build plan 

`ARCHITECTURE.md` §9 assumed Layer A/B work happens after the core loop is proven on Navi's
own screens (old step 9, "Phase 2"). Per the 2026-08-23 decision to target third-party sites
directly, revised order (see `ARCHITECTURE.md` §9 for the authoritative updated list):

1. Data layer + auth — **done**.
2. Orchestrator + LLM Gateway — one provider, minimal LangGraph loop. Still the first thing
   to build; nothing above has anywhere to run without it.
3. Data MCP + Profiling & Adaptation Agent, proven against the 3 mini-games' evidence
   (already flowing into `evidence_log`) — the propose→validate→consent loop, but the
   validator built from day one is the Layer A vocabulary validator (§2), not a
   Navi-screens-only selector whitelist, since selectors are being skipped.
4. WebView screen + Browser Bridge MCP — needed as the injection surface before Layer A can
   apply to anything.
5. Layer A (generic styling) end to end on real third-party pages — this is the first real
   "adapts any site" result, and has no detection dependency.
6. Web Reader MCP (main-content extraction) + Scanner MCP (vision) — prerequisites for
   Layer B, built once Layer A is validated working.
7. Layer B (decluttering) — heuristic pass first, vision pass second, consent gate, on top
   of a working Layer A.
8. Voice (STT/TTS), contextual bandit — unchanged from the original plan, still last.
