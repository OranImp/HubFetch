"""Structural contract tests for the root HubFetch ``DESIGN.md``.

Given/When/Then: the root Transfer Ledger contract exists before any widget
source; every mandated section appears in order; the locked light tokens,
typography, spacing, radii, states, breakpoints, personas, motion window,
reduced-motion behavior, and debt discipline are present; and banned design
patterns never appear as prescriptive rules.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parents[2]
DESIGN_PATH: Final = ROOT / "DESIGN.md"

REQUIRED_SECTIONS: Final = (
    "## 0. Research Log",
    "## 1. Atmosphere & Identity",
    "## 2. Personas",
    "## 3. Constraints",
    "## 4. Content Inventory",
    "## 5. Design Tokens",
    "## 6. Components",
    "## 7. Motion",
    "## 8. Layout",
    "## 9. Theme Mapping",
    "## 10. Localization",
    "## 11. Showcase",
    "## 12. Visual QA",
    "## 13. Accepted Debt",
    "## 14. Handoff",
)

LOCKED_TOKENS: Final = (
    "#202124",
    "#F7F8FA",
    "#FFFFFF",
    "#D9DEE7",
    "#FFD21E",
    "#2563EB",
)

NEGATION_WORDS: Final = (
    "no",
    "not",
    "never",
    "without",
    "avoid",
    "banned",
    "forbidden",
    "prohibited",
    "do not",
    "must not",
    "don't",
)

BANNED_PATTERNS: Final = (
    ("gradient", r"gradient"),
    ("card nesting", r"card\s+inside\s+(?:a\s+)?card|nested\s+card"),
    ("HF logo", r"\bHF\s+logo\b|hugging\s*face\s+logo"),
    ("dashboard hero", r"dashboard\s+hero|hero\s+(?:section|banner|image|screen)"),
    ("orb", r"\borbs?\b"),
    ("emoji icon", r"\bemoji\b"),
    ("copied branding", r"cop(y|ied).{0,24}branding|raycast\s+branding"),
)


def _document() -> str:
    """Return the current root design contract text."""
    return DESIGN_PATH.read_text(encoding="utf-8")


def _section(document: str, heading: str) -> str:
    """Return text under ``heading`` up to the next equal-or-higher heading."""
    lines = document.splitlines()
    start = next((index for index, line in enumerate(lines) if line == heading), -1)
    assert start >= 0, f"missing required section {heading!r}"
    level = heading.count("#")
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.startswith("#") and line.count("#") <= level and line != heading:
            return "\n".join(lines[start:index])
    return "\n".join(lines[start:])


def test_required_sections_appear_in_order() -> None:
    """Given the contract, every mandated section exists in sequence."""
    document = _document()

    positions = [document.index(heading) for heading in REQUIRED_SECTIONS]

    assert positions == sorted(positions)


def test_research_log_records_direction_and_evidence() -> None:
    """Given the log, the comparison, taste, evidence, and skips are present."""
    log = _section(_document(), "## 0. Research Log")

    assert "Transfer Ledger" in log
    assert "Native Fluent" in log
    assert "Dark Operations" in log
    assert "Raycast" in log
    assert re.search(
        r"navigation.*typography.*writing.*responsive.*accessibility.*motion", log
    )
    assert re.search(r"unavailable|skipped", log)


def test_personas_cover_all_three_roles() -> None:
    """Given the personas section, all three mandated personas are named."""
    personas = _section(_document(), "## 2. Personas")

    assert "power downloader" in personas
    assert "occasional private-repo user" in personas
    assert "support maintainer" in personas


def test_constraints_cover_cognitive_and_a11y() -> None:
    """Given the constraints section, cognitive and accessibility rules exist."""
    constraints = _section(_document(), "## 3. Constraints")

    assert "cognitive" in constraints
    assert re.search(r"keyboard.*focus.*contrast.*screen reader", constraints)


def test_content_inventory_covers_states_and_scaling() -> None:
    """Given the inventory, empty/error states and long-content fixtures exist."""
    inventory = _section(_document(), "## 4. Content Inventory")

    assert "empty" in inventory
    assert "error" in inventory
    assert "200%" in inventory


def test_locked_light_tokens_present() -> None:
    """Given the tokens section, every locked light color token is declared."""
    tokens = _section(_document(), "## 5. Design Tokens")

    for token in LOCKED_TOKENS:
        assert token in tokens, f"missing locked token {token}"


def test_typography_spacing_and_radii_contracts() -> None:
    """Given the tokens section, faces, 4/8 px steps, and the 8 px cap hold."""
    tokens = _section(_document(), "## 5. Design Tokens")

    assert "Segoe UI Variable" in tokens
    assert "Microsoft YaHei UI" in tokens
    assert "Cascadia Mono" in tokens
    assert "OFL" in tokens
    assert re.search(r"4\s*px", tokens)
    assert re.search(r"8\s*px", tokens)


def test_icon_policy_uses_lucide_without_emoji() -> None:
    """Given the icon policy, Lucide is mandated and emoji is excluded."""
    tokens = _section(_document(), "## 5. Design Tokens")

    assert "Lucide" in tokens
    assert "emoji" in tokens


def test_component_anatomy_states_and_rail() -> None:
    """Given the components section, anatomy, states, and the rail exist."""
    components = _section(_document(), "## 6. Components")

    assert "primitive" in components
    assert "stage rail" in components
    assert re.search(
        r"default.*hover.*pressed.*focus.*disabled.*loading.*empty.*error",
        components,
    )
    assert "only custom expressive control" in components
    assert "accessible" in components
    assert re.search(r"reduced[ -]motion", components)
    assert "color alone" in components


def test_motion_window_and_reduced_motion_behavior() -> None:
    """Given the motion section, the 83-167 ms window and pulse rule hold."""
    motion = _section(_document(), "## 7. Motion")

    assert "83-167" in motion
    assert "pulse" in motion
    assert re.search(r"reduced[ -]motion", motion)


def test_layout_scroll_ownership_and_breakpoints() -> None:
    """Given the layout section, one scroll owner and three widths exist."""
    layout = _section(_document(), "## 8. Layout")

    assert "scroll" in layout
    assert re.search(r"<760.*760-1179.*>=1180", layout)


def test_theme_mapping_derives_from_system_roles() -> None:
    """Given the theme section, dark/high-contrast map from Qt system roles."""
    theme = _section(_document(), "## 9. Theme Mapping")

    assert "system role" in theme
    assert "high contrast" in theme
    assert "one-note" in theme


def test_localization_expansion_and_stable_verbs() -> None:
    """Given the localization section, both locales and stable pairs exist."""
    localization = _section(_document(), "## 10. Localization")

    assert "Simplified Chinese" in localization
    assert "English" in localization
    assert "取消任务" in localization


def test_showcase_inventory_and_visual_qa_matrix() -> None:
    """Given showcase and QA sections, widths, themes, and scaling are listed."""
    showcase = _section(_document(), "## 11. Showcase")
    qa = _section(_document(), "## 12. Visual QA")

    assert "showcase" in showcase
    assert "760" in showcase
    assert "1180" in qa
    assert "high contrast" in qa
    assert "200%" in qa


def test_accepted_debt_and_handoff_rules_recorded() -> None:
    """Given debt and handoff sections, the discipline and gates are named."""
    debt = _section(_document(), "## 13. Accepted Debt")
    handoff = _section(_document(), "## 14. Handoff")

    assert "None accepted" in debt
    assert "affected users" in debt
    assert "showcase" in handoff
    assert "token" in handoff


def test_banned_design_patterns_are_absent() -> None:
    """Given the contract, no banned pattern appears outside a prohibition."""
    document = _document()
    offenders: list[str] = []
    for line_number, line in enumerate(document.splitlines(), start=1):
        lowered = line.lower()
        if any(word in lowered for word in NEGATION_WORDS):
            continue
        for label, pattern in BANNED_PATTERNS:
            if re.search(pattern, line):
                offenders.append(f"line {line_number}: {label} ({line.strip()})")

    assert offenders == [], "banned design patterns:\n" + "\n".join(offenders)
