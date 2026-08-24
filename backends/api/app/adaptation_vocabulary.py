"""The Layer A adaptation vocabulary (docs/THIRD_PARTY_ADAPTATION.md §2) — the closed set of
values the Profiling & Adaptation Agent may propose. Shared by the agent (which asks an LLM
to fill this schema) and the validator (which clamps/rejects independently of what the LLM
returned) so both sides agree on the same bounds by construction, not by convention.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

LineSpacing = Literal["normal", "relaxed", "loose"]
LetterSpacing = Literal["normal", "wide"]
ContrastMode = Literal["none", "high", "dark"]

FONT_SCALE_MIN = 1.0
FONT_SCALE_MAX = 1.8

# Ordering used by the validator's monotonicity check (docs/ARCHITECTURE.md §0 principle #5:
# an accepted adaptation only ever moves toward *more* accessible, never less).
LINE_SPACING_RANK: dict[LineSpacing, int] = {"normal": 0, "relaxed": 1, "loose": 2}
LETTER_SPACING_RANK: dict[LetterSpacing, int] = {"normal": 0, "wide": 1}
CONTRAST_RANK: dict[ContrastMode, int] = {"none": 0, "high": 1, "dark": 1}  # high/dark are
# alternatives, not a ladder — neither is "more" than the other, so validate_proposal treats
# any change between them as allowed rather than ranked.


class AdaptationProposal(BaseModel):
    # extra="forbid": any key outside this schema is a hard validation error, not silently
    # dropped — the "rejects any key not in the vocabulary" half of the closed-vocabulary
    # contract (docs/THIRD_PARTY_ADAPTATION.md §2), enforced by construction.
    model_config = ConfigDict(extra="forbid")

    font_scale: float = Field(
        ge=FONT_SCALE_MIN,
        le=FONT_SCALE_MAX,
        description="1.0 = no change, 1.8 = largest. Raise for low motor_precision or reading_comfort.",
    )
    line_spacing: LineSpacing = Field(description="Raise for low reading_comfort.")
    letter_spacing: LetterSpacing = Field(description="Raise for low reading_comfort.")
    contrast_mode: ContrastMode = Field(
        description="Raise for low reading_comfort or an unusual visual_processing_style profile."
    )
    reduce_motion: bool = Field(description="True for low motor_precision or visual_processing_style.")
    touch_target_boost: bool = Field(description="True for low motor_precision.")
    reading_mode: bool = Field(description="True for low reading_comfort.")
    rationale: str = Field(
        description=(
            "One sentence explaining the proposal in terms of the measured axes "
            "(motor_precision / reading_comfort / visual_processing_style) — never a "
            "medical condition or diagnosis (docs/ARCHITECTURE.md §0 principle #2)."
        )
    )


def neutral_proposal() -> AdaptationProposal:
    """The floor everything is measured against — 'no adaptation' as a real value, not a
    special-cased None, so the monotonicity check always has something to compare against."""
    return AdaptationProposal(
        font_scale=FONT_SCALE_MIN,
        line_spacing="normal",
        letter_spacing="normal",
        contrast_mode="none",
        reduce_motion=False,
        touch_target_boost=False,
        reading_mode=False,
        rationale="Aucune adaptation proposée.",
    )
