"""Structural validator for the root HubFetch Transfer Ledger design contract.

Asserts the mandated DESIGN.md sections, tokens, states, breakpoints,
personas, motion, theme, localization, debt, and handoff clauses and rejects
banned design patterns used as prescriptive rules.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Sequence

NEGATION_WORDS: Final = (
    "no",
    "not",
    "never",
    "without",
    "avoid",
    "banned",
    "forbidden",
    "prohibited",
    "don't",
)

BANNED_PATTERNS: Final = (
    ("gradient", r"gradient"),
    ("card-nesting", r"card\s+inside\s+(?:a\s+)?card|nested\s+card"),
    ("hf-logo", r"\bHF\s+logo\b|hugging\s*face\s+logo"),
    ("dashboard-hero", r"dashboard\s+hero|hero\s+(?:section|banner|image|screen)"),
    ("orb", r"\borbs?\b"),
    ("emoji-icon", r"\bemoji\b"),
    ("copied-branding", r"cop(y|ied).{0,24}branding|raycast\s+branding"),
)

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

REQUIRED_CLAUSES: Final = (
    ("research", "direction", "## 0. Research Log", r"Transfer Ledger"),
    ("native-fluent", "comparison", "## 0. Research Log", r"Native Fluent"),
    ("dark-ops", "comparison", "## 0. Research Log", r"Dark Operations"),
    ("taste", "raycast reference", "## 0. Research Log", r"Raycast"),
    ("win-nav", "navigation", "## 0. Research Log", r"navigation"),
    ("win-type", "typography", "## 0. Research Log", r"typography"),
    ("win-a11y", "accessibility", "## 0. Research Log", r"accessibility"),
    ("win-motion", "motion", "## 0. Research Log", r"motion"),
    ("skip-lanes", "skipped lanes", "## 0. Research Log", r"unavailable|skipped"),
    ("persona1", "power downloader", "## 2. Personas", r"power downloader"),
    ("persona2", "private-repo user", "## 2. Personas", r"private-repo user"),
    ("persona3", "support maintainer", "## 2. Personas", r"support maintainer"),
    ("cognitive", "cognitive rules", "## 3. Constraints", r"cognitive"),
    ("a11y-keyboard", "keyboard", "## 3. Constraints", r"keyboard"),
    ("a11y-focus", "focus", "## 3. Constraints", r"focus"),
    ("a11y-contrast", "contrast", "## 3. Constraints", r"contrast"),
    ("a11y-reader", "screen reader", "## 3. Constraints", r"screen reader"),
    ("content-long", "200% fixtures", "## 4. Content Inventory", r"200%"),
    ("token-ink", "Ink token", "## 5. Design Tokens", r"#202124"),
    ("token-canvas", "Canvas token", "## 5. Design Tokens", r"#F7F8FA"),
    ("token-surface", "Surface token", "## 5. Design Tokens", r"#FFFFFF"),
    ("token-line", "Line token", "## 5. Design Tokens", r"#D9DEE7"),
    ("token-yellow", "Signal Yellow", "## 5. Design Tokens", r"#FFD21E"),
    ("token-blue", "Action Blue", "## 5. Design Tokens", r"#2563EB"),
    ("type-segoe", "Segoe UI Variable", "## 5. Design Tokens", r"Segoe UI Variable"),
    ("type-yahei", "Microsoft YaHei UI", "## 5. Design Tokens", r"Microsoft YaHei UI"),
    ("type-cascadia", "Cascadia Mono", "## 5. Design Tokens", r"Cascadia Mono"),
    ("spacing-4", "4 px base", "## 5. Design Tokens", r"4\s*px"),
    ("spacing-8", "8 px step", "## 5. Design Tokens", r"8\s*px"),
    ("radii-max-8", "8 px cap", "## 5. Design Tokens", r"8\s*px"),
    ("depth-borders", "borders depth", "## 5. Design Tokens", r"border"),
    ("icon-lucide", "Lucide set", "## 5. Design Tokens", r"Lucide"),
    ("icon-no-emoji", "no emoji", "## 5. Design Tokens", r"emoji"),
    ("anatomy", "primitive anatomy", "## 6. Components", r"primitive"),
    ("state-default", "default", "## 6. Components", r"default"),
    ("state-hover", "hover", "## 6. Components", r"hover"),
    ("state-focus", "focus", "## 6. Components", r"focus"),
    ("state-disabled", "disabled", "## 6. Components", r"disabled"),
    ("state-error", "error", "## 6. Components", r"error"),
    ("rail-only", "only custom", "## 6. Components", r"only custom expressive control"),
    ("rail-accessible", "accessible", "## 6. Components", r"accessible"),
    ("rail-reduced", "reduced motion", "## 6. Components", r"reduced[ -]motion"),
    ("rail-no-color", "no color alone", "## 6. Components", r"color alone"),
    ("motion-window", "83-167 ms", "## 7. Motion", r"83-167"),
    ("motion-pulse", "stage pulse", "## 7. Motion", r"pulse"),
    ("motion-reduced", "reduced motion", "## 7. Motion", r"reduced[ -]motion"),
    ("scroll-owner", "scroll owner", "## 8. Layout", r"scroll"),
    ("breakpoints", "three widths", "## 8. Layout", r"<760.*760-1179.*>=1180"),
    ("theme-roles", "system roles", "## 9. Theme Mapping", r"system role"),
    ("theme-high-contrast", "high contrast", "## 9. Theme Mapping", r"high contrast"),
    ("theme-no-one-note", "one-note ban", "## 9. Theme Mapping", r"one-note"),
    ("locale-zh", "Simplified Chinese", "## 10. Localization", r"Simplified Chinese"),
    ("locale-verbs", "stable verbs", "## 10. Localization", r"取消任务"),
    ("showcase", "showcase", "## 11. Showcase", r"showcase"),
    ("qa-themes", "high contrast", "## 12. Visual QA", r"high contrast"),
    ("qa-scaling", "200% scaling", "## 12. Visual QA", r"200%"),
    ("debt-none", "none accepted", "## 13. Accepted Debt", r"None accepted"),
    ("debt-entries", "affected users", "## 13. Accepted Debt", r"affected users"),
    ("handoff-showcase", "showcase", "## 14. Handoff", r"showcase"),
    ("handoff-tokens", "tokens first", "## 14. Handoff", r"token"),
)


@dataclass(frozen=True, slots=True)
class Section:
    """A Markdown section bounded by its heading level."""

    heading: str
    content: str


@dataclass(frozen=True, slots=True)
class ClauseResult:
    """The outcome of one required-contract clause check."""

    label: str
    description: str
    present: bool
    location: str


@dataclass(frozen=True, slots=True)
class Violation:
    """A banned design pattern found outside a prohibition statement."""

    line: int
    column: int
    rule: str
    message: str

    def render(self) -> str:
        """Render the violation in compiler-style form."""
        return f"DESIGN.md:{self.line}:{self.column}: [{self.rule}] {self.message}"


@dataclass(frozen=True, slots=True)
class ContractReport:
    """The complete structural verdict for one design document."""

    clauses: tuple[ClauseResult, ...]
    violations: tuple[Violation, ...]

    def ok(self) -> bool:
        """Return whether every clause passed and no violation exists."""
        return all(result.present for result in self.clauses) and not self.violations

    def as_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation of the verdict."""
        return {
            "ok": self.ok(),
            "clauses": [
                {
                    "label": result.label,
                    "description": result.description,
                    "present": result.present,
                    "location": result.location,
                }
                for result in self.clauses
            ],
            "violations": [violation.render() for violation in self.violations],
        }


def split_sections(document: str) -> tuple[Section, ...]:
    """Split the document into sections by Markdown heading level."""
    lines = document.splitlines()
    headings = tuple(
        (index, line) for index, line in enumerate(lines) if line.startswith("#")
    )
    sections: list[Section] = []
    for position, (start, heading) in enumerate(headings):
        level = heading.count("#")
        content_end = len(lines)
        for next_start, next_heading in headings[position + 1 :]:
            if next_heading.count("#") <= level:
                content_end = next_start
                break
        sections.append(
            Section(heading=heading, content="\n".join(lines[start:content_end]))
        )
    return tuple(sections)


def is_prohibition(line: str) -> bool:
    """Return whether a line is a prohibition, exempting it from pattern bans."""
    lowered = line.lower()
    return any(word in lowered for word in NEGATION_WORDS)


def check_clauses(sections: tuple[Section, ...]) -> tuple[ClauseResult, ...]:
    """Check every required clause against its section's content."""
    section_by_heading = {section.heading: section for section in sections}
    results: list[ClauseResult] = []
    for label, description, heading, pattern in REQUIRED_CLAUSES:
        section = section_by_heading.get(heading)
        if section is None:
            results.append(
                ClauseResult(
                    label, description, present=False, location="missing section"
                )
            )
            continue
        found = re.search(pattern, section.content, flags=re.DOTALL) is not None
        results.append(ClauseResult(label, description, found, heading))
    return tuple(results)


def check_banned_patterns(document: str) -> tuple[Violation, ...]:
    """Find banned design patterns that appear outside a prohibition."""
    violations: list[Violation] = []
    for line_number, line in enumerate(document.splitlines(), start=1):
        if is_prohibition(line):
            continue
        for rule, pattern in BANNED_PATTERNS:
            match = re.search(pattern, line)
            if match is None:
                continue
            violations.append(
                Violation(
                    line_number,
                    match.start() + 1,
                    rule,
                    f"banned pattern {rule!r} appears as a prescriptive rule",
                )
            )
    return tuple(violations)


def verify_contract(document: str) -> ContractReport:
    """Return the structural verdict for a design contract document."""
    sections = split_sections(document)
    clauses = check_clauses(sections)
    violations = check_banned_patterns(document)
    return ContractReport(clauses, violations)


def main(arguments: Sequence[str] | None = None) -> int:
    """Run the checker against a design document path and optional JSON output."""
    argv = list(arguments) if arguments is not None else sys.argv[1:]
    design_path = Path(argv[0]) if argv else Path("DESIGN.md")
    json_path: Path | None = None
    if "--json" in argv:
        flag_index = argv.index("--json")
        if flag_index + 1 < len(argv):
            json_path = Path(argv[flag_index + 1])
    report = verify_contract(design_path.read_text(encoding="utf-8"))
    if json_path is not None:
        _ = json_path.write_text(
            json.dumps(report.as_dict(), indent=2) + "\n", encoding="utf-8"
        )
    missing = [result.label for result in report.clauses if not result.present]
    print(
        f"clauses missing: {len(missing)}"
        if missing
        else "all required clauses present"
    )
    for violation in report.violations:
        print(violation.render(), file=sys.stderr)
    return 0 if report.ok() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
