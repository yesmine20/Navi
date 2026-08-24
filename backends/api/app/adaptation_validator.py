"""The hard safety gate (docs/ARCHITECTURE.md §0 principle #5, §5): plain code, no LLM,
runs after the agent's proposal and can only ever make it *less* extreme, never invent or
approve anything outside the vocabulary. This is the one piece that must stay simple, tested,
and boring — no new adaptation logic belongs here, only clamping and monotonicity.
"""

from app.adaptation_vocabulary import (
    CONTRAST_RANK,
    FONT_SCALE_MAX,
    FONT_SCALE_MIN,
    LETTER_SPACING_RANK,
    LINE_SPACING_RANK,
    AdaptationProposal,
    neutral_proposal,
)


def validate_proposal(
    proposal: AdaptationProposal, previous_accepted: AdaptationProposal | None
) -> AdaptationProposal:
    """Clamps `proposal` to the declared vocabulary bounds and enforces monotonicity against
    `previous_accepted` (the neutral/no-adaptation state if the user has never accepted one).

    Monotonicity means: this user's adaptation only ever moves toward *more* accessible than
    what they already have, never less — a later proposal can't walk back an axis the user is
    already benefiting from, even if fresh evidence looks "better" on some other axis.
    Reverting is a user action (`adaptation_feedback: revert`), never something the agent
    proposes on their behalf.
    """
    baseline = previous_accepted or neutral_proposal()

    font_scale = min(FONT_SCALE_MAX, max(FONT_SCALE_MIN, proposal.font_scale))
    font_scale = max(font_scale, baseline.font_scale)

    line_spacing = (
        proposal.line_spacing
        if LINE_SPACING_RANK[proposal.line_spacing] >= LINE_SPACING_RANK[baseline.line_spacing]
        else baseline.line_spacing
    )
    letter_spacing = (
        proposal.letter_spacing
        if LETTER_SPACING_RANK[proposal.letter_spacing] >= LETTER_SPACING_RANK[baseline.letter_spacing]
        else baseline.letter_spacing
    )
    # "none" is the only floor here — high vs. dark is a lateral choice, not a ladder, so a
    # switch between them is allowed; only a drop back to "none" after a real mode was
    # accepted counts as a regression.
    contrast_mode = (
        baseline.contrast_mode
        if CONTRAST_RANK[proposal.contrast_mode] < CONTRAST_RANK[baseline.contrast_mode]
        else proposal.contrast_mode
    )

    return AdaptationProposal(
        font_scale=font_scale,
        line_spacing=line_spacing,
        letter_spacing=letter_spacing,
        contrast_mode=contrast_mode,
        reduce_motion=proposal.reduce_motion or baseline.reduce_motion,
        touch_target_boost=proposal.touch_target_boost or baseline.touch_target_boost,
        reading_mode=proposal.reading_mode or baseline.reading_mode,
        rationale=proposal.rationale,
    )
