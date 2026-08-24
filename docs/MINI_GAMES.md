# Navi v2 — Mini-games (capability measurement)

Locks the mini-games doc referenced as "à venir" in [`CADRAGE.md`](./CADRAGE.md) §7. Confirms
the 1-game-per-axis mapping for the MVP's three capability axes (§5 of `CADRAGE.md`).

---

## 1. Confirmed mapping — 3 games, 3 axes

| Axis (`capability_profile`) | Perceived target (inspiration only, never stored) | Game | Field name |
|---|---|---|---|
| Motor precision | Parkinson (motor) | Follow the Path | `motorStabilityScore` |
| Reading comfort | Dyslexia (reading) | Reading Challenge | `readingComfortScore` |
| Visual processing style | Autism (perceptual style) | Pattern Detective | `detailProcessingAffinity` |

**Rejected: "Équilibre du Verre" (glass-balance hold game).** Was mocked up alongside the three
games above, but has no research backing (unlike the three below) and duplicates the motor axis
with a different mechanic (static/postural hold vs. dynamic tracing). Dropped rather than kept as
a fourth, unvalidated signal — see §4 for why that matters here specifically.

**"Charge cognitive" removed from the mini-game mapping.** It was the original 3rd axis
candidate in `CADRAGE.md` §5, but unlike the axis above it doesn't need a dedicated game: time on
task, back-tracking, and abandon rate (its listed signals) are observable passively from normal
app usage. Visual processing style, by contrast, cannot be observed passively — it only shows up
under a constructed task like Pattern Detective. That's the deciding difference between the two:
one axis is replaceable by ambient telemetry, the other is not. Cognitive load may still be
tracked later as a passive signal, but it does not get a mini-game slot in the MVP.

---

## 2. Follow the Path — fine motor control

**Symptom detected:** reduced hand steadiness, tremor, or poor sustained precision during
drag/trace movements.

**What it measures:** several precise movement behaviors, not one blended score — the same
features researchers look at when studying Parkinsonian movement, each isolated so the Profiling
& Adaptation Agent can weigh them independently rather than reasoning over one opaque number:

| Behavior | Signal | What it can indicate |
|---|---|---|
| Accuracy | `pathDeviationAvg/Median/P95/Max`, and each normalized by path width (`*Norm`) | how closely the trace follows the path, in both raw px and a device/screen-independent scale |
| Off-path time & corrections | `timeOffPathMs/Ratio`, `corrections` (+ `Large`/`Small` split), each computed twice — against the fixed pixel tolerance and against a threshold relative to the round's own median deviation (`*Relative*`) | how much of the round was off-path, and whether excursions were fine oscillations or large dysmetria-scale corrections |
| Speed | `avgSpeed`, `speedStart`, `speedEnd`, `speedEndToStartRatio`, `speedCV`, `speedSlope` | overall slowness, and — via the slope of speed over time — progressive slowing within the round (bradykinesia "sequence effect") |
| Rhythm | `waypointIntervalsMs`, `waypointIntervalCV`, `intervalTrend` | how regular the timing is between checkpoints along the path, and whether that rhythm drifts as the round progresses |
| Smoothness | `smoothness` (inverse coefficient of variation of speed) | stop-and-go vs continuous movement |

Deviation is normalized by the path's own horizontal span (`PATH_WIDTH_PX` in the game code) rather
than a fixed pixel count, so it stays interpretable across screen sizes/densities. The relative
excursion threshold (median deviation × 1.75) exists precisely because the fixed 22px tolerance is
arbitrary (see the discussion this replaces) — both versions are kept side by side so the agent
can compare which correlates better with real outcomes, rather than picking one now by guesswork.

The finger leaving the path never ends the round — the round only ends on completion or the user
lifting their finger; deviation is a continuous signal, not a fail state. The raw trajectory
(timestamped position + deviation per sample) is captured in full rather than reduced to
aggregates client-side, so tremor amplitude/frequency (left/right oscillation around the path)
can be analyzed from the actual time series later — that computation, and turning any of this
into a single capability score, is deliberately not done on-device (`ARCHITECTURE.md` §0
principle #5: decision content is never hardcoded, including derived scores).

None of these signals are individually diagnostic, and the game must never imply one is — see the
framing note in §5.

**Research backing:**
- Wang, S. et al. (2025), *Clinical Applications and Measurement Properties of the Digitized
  Archimedes Spiral Drawing Test: A Scoping Review*, Movement Disorders Clinical Practice (DOI:
  10.1002/mdc3.70278) — tracing/spiral-drawing tasks reliably capture tremor amplitude, path
  deviation, and movement smoothness across dozens of studies.
- Bot, B. M. et al. (2016), the mPower study — a smartphone touchscreen alone, no external
  sensor, captures meaningful motor-control variation at scale, across a general population.

**Why it holds at the symptom level:** the task isolates *sustained* control over time (unlike a
single tap). Poor performance means bigger touch targets and fewer fine-precision gestures are
needed, regardless of the underlying cause.

---

## 3. Reading Challenge — reading fluency

**Symptom detected:** slow reading relative to sentence length, low comprehension accuracy, or
long hesitation before answering.

**What it measures:** three sentences of increasing, objectively-graded complexity (7/12/19
words — thresholds, not a hand-picked "complex word" list, for the same reason the game avoids
other arbitrary judgment calls), each followed by a comprehension question:

| Behavior | Signal | What it can indicate |
|---|---|---|
| Reading speed | `wordsPerMinute`, `comprehendedWordsPerMinute`, per-round `wpm` | overall reading pace — see naming note below on why this isn't called WCPM |
| Comprehension | `readingAccuracyByWords` (word-weighted), `roundAccuracy` (coarser, 1 of 4 values with only 3 rounds) | whether reading translated into understanding, not just speed |
| Speed × accuracy quadrant | `fastCorrectCount/slowCorrectCount/fastWrongCount/slowWrongCount` (fast/slow relative to this session's own median time-per-char) | separates skimming/guessing (fast+wrong) from genuine struggle (slow+wrong) |
| Complexity effect | `wpmByComplexity`, `accuracyByComplexity`, `timePerCharByComplexity`, `complexityEffect*` (level 1 vs level 3) | whether the user is disproportionately affected by harder text, not just uniformly slow — the effect research (see below) associates with reading difficulty, more than raw speed alone |
| Fatigue | `wpmSlope`, `timePerCharSlope`, `accuracyTrend` (regression across the 3 rounds) | progressive slowing/more errors within the session, distinct from being uniformly slow |
| Hesitation | `avgHesitationTimeMs`, per-round `hesitationTimeMs` | time between the question appearing and an answer being given |

**Naming note — this is not WCPM.** Classic WCPM (words correct per minute) comes from *oral*
reading fluency testing — a human listener counts words read aloud correctly. This game is
*silent* reading + a comprehension question, so there is no word-level correctness to count. A
word is instead counted as "comprehended" if it belongs to a sentence whose question was
answered correctly (`comprehendedWords`) — a sentence-level approximation, not a word-level
measure. Naming reflects that: `comprehendedWordsPerMinute`, not `wordsCorrectPerMinute`.

**Research backing:**
- Rello, L. & Baeza-Yates, R. (2016), *The Effect of Font Type on Screen Readability by People
  with Dyslexia* — eye-tracking study (97 participants, 48 with dyslexia) showing font
  type/size measurably changes reading speed and fixation behavior.
- Rello, L. et al. (2013) — reading-speed gains from larger text plateau past roughly 18pt; a
  single blanket text-size increase is not a universal fix.
- Pelli, D. G. et al. (2007) — the same speed/size relationship holds broadly across readers in
  general, not only in a diagnosed subgroup.

**Why it holds at the symptom level:** time, accuracy, and hesitation together describe reading
strain as a functional state. Fatigue, an unfamiliar language, low literacy, or a reading
difficulty can all produce the same pattern, and all warrant the same response — bigger text,
more spacing, or a simplified reading mode.

**What the research backing does and doesn't justify.** The font-size/type findings above
validate that font is a lever worth having in the adaptation vocabulary — they don't mean this
game needs to test different fonts to be valid. The game's job is to detect *whether* there's
reading strain; *which* specific adaptation (font size vs spacing vs simplified mode) helps this
particular user is what the accept/decline/revert feedback loop (`ARCHITECTURE.md` §5) is for,
over time — not something this game can determine from a single baseline-format session.

No combined "reading difficulty level" is computed here, on purpose — same reasoning as Follow
the Path: turning these signals into one flag (low/medium/high) is decision content, reserved for
the Profiling & Adaptation Agent's reasoning (`ARCHITECTURE.md` §0 principle #5), not something
to hardcode into the game.

---

## 4. Pattern Detective — visual processing style

**Symptom detected:** unusually fast and accurate detection of a shape hidden inside visual
clutter — a strength pattern, not a deficit.

**What it measures:** time to find a simple shape hidden inside a denser overlapping figure, and
miss count, across three rounds of increasing visual complexity. It's a continuous score, not a
binary flag — slow-and-inaccurate even on the easy round pushes the score low, fast-and-accurate
through the hard round pushes it high.

**Research backing:**
- Shah, A. & Frith, U. (1983), *An islet of ability in autistic children: A research note* —
  first documented this fast embedded-figure detection pattern.
- Wallace, S. et al., *Embedded Figures Test Performance in the Broader Autism Phenotype: A
  Meta-analysis*, Journal of Autism and Developmental Disorders — confirms the effect replicates
  across studies and scales with trait level.
- Happé, F. & Frith, U. (2006) — the "enhanced perceptual functioning" account: locally-oriented
  visual processing, a processing style rather than an impairment.

**Why it holds at the symptom level:** the cleanest case for symptom-first framing, since the
measured trait is not a difficulty at all. The design response follows directly: offer more
visual density and detail for these users, instead of only ever simplifying the interface.

---

## 5. Framing note (non-negotiable, mirrors `CADRAGE.md` §5-6)

Each paper above validates the underlying task as a measure of a real cognitive or motor
construct (reading fluency, fine motor control, local visual processing). **None of them
validate a mobile mini-game as a diagnostic instrument.** Internal field names and user-facing
copy stay at the symptom level (`motorStabilityScore`, `readingComfortScore`,
`detailProcessingAffinity`) and never reference a named medical or clinical condition — this
keeps the feature a UX-personalization signal rather than an undisclosed health-screening tool,
which matters both scientifically and for regulatory exposure (medical-device / health-claim
rules) in most jurisdictions.
