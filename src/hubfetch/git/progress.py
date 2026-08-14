"""Parsing of documented Git clone progress records into typed phases.

Only Git's documented stderr progress records are recognized: the
``remote:``-prefixed enumerating/counting/compressing lines and the
receiving/resolving/updating lines. Any other stderr line is retained as a
sanitized diagnostic through the Todo 5 redactor -- never parsed and never
discarded -- so support output stays honest.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum, unique
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from hubfetch.security.redaction import Redactor


@unique
class ProgressPhase(StrEnum):
    """Closed phases documented in Git clone progress output."""

    ENUMERATING = "enumerating"
    COUNTING = "counting"
    COMPRESSING = "compressing"
    RECEIVING = "receiving"
    RESOLVING = "resolving"
    UPDATING = "updating"


@dataclass(frozen=True, slots=True)
class GitProgressRecord:
    """One parsed progress record with counts and an optional sanitized rate."""

    phase: ProgressPhase
    done: int
    total: int
    rate: str | None = None


@dataclass(frozen=True, slots=True)
class ParsedProgress:
    """Typed records plus the sanitized unparsed diagnostic lines."""

    records: tuple[GitProgressRecord, ...]
    diagnostics: tuple[str, ...]


_ENUMERATING_PREFIX: Final = "Enumerating objects:"
_ENUMERATING_PATTERN: Final = re.compile(r"(\d+), done\.")
_PERCENT_PATTERN: Final = re.compile(r"(\d{1,3})% \((\d+)/(\d+)\)(?:, (.*))?")
_MAX_PERCENT: Final = 100
_OBJECT_PHASES: Final = {
    "Counting objects": ProgressPhase.COUNTING,
    "Compressing objects": ProgressPhase.COMPRESSING,
    "Receiving objects": ProgressPhase.RECEIVING,
    "Resolving deltas": ProgressPhase.RESOLVING,
    "Updating files": ProgressPhase.UPDATING,
}
"""Documented percentage-based phases and their leading prefixes."""


def _extract_rate(tail: str | None) -> str | None:
    """Extract the rate from a progress tail, dropping the done marker."""
    if not tail:
        return None
    if tail.endswith(", done."):
        tail = tail[: -len(", done.")]
    elif tail == "done.":
        return None
    return tail.strip() or None


def parse_progress_line(raw_line: str) -> GitProgressRecord | None:
    """Parse one documented Git progress line, or return None for unparsed."""
    line = raw_line.strip()
    if line.startswith("remote:"):
        line = line[len("remote:") :].strip()
    if line.startswith(_ENUMERATING_PREFIX):
        tail = line[len(_ENUMERATING_PREFIX) :].strip()
        match = _ENUMERATING_PATTERN.fullmatch(tail)
        if match is None:
            return None
        count = int(match.group(1))
        return GitProgressRecord(
            phase=ProgressPhase.ENUMERATING, done=count, total=count
        )
    for prefix, phase in _OBJECT_PHASES.items():
        if not line.startswith(prefix + ":"):
            continue
        tail = line[len(prefix) + 1 :].strip()
        match = _PERCENT_PATTERN.fullmatch(tail)
        if match is None or int(match.group(1)) > _MAX_PERCENT:
            return None
        return GitProgressRecord(
            phase=phase,
            done=int(match.group(2)),
            total=int(match.group(3)),
            rate=_extract_rate(match.group(4)),
        )
    return None


def parse_progress_stderr(
    text: str, *, redactor: Redactor | None = None
) -> ParsedProgress:
    """Parse whole stderr text into typed records and sanitized diagnostics."""
    records: list[GitProgressRecord] = []
    diagnostics: list[str] = []
    for raw_line in text.splitlines():
        record = parse_progress_line(raw_line)
        if record is not None:
            records.append(record)
            continue
        line = raw_line.rstrip("\r\n")
        if redactor is not None:
            line = redactor.redact_text(line)
        diagnostics.append(line)
    return ParsedProgress(records=tuple(records), diagnostics=tuple(diagnostics))
