"""Headless scenario runner for the integrated HubFetch transfer runtime.

Usage::

    python -m hubfetch.scenarios.main --scenario <name> --evidence <dir>

Each scenario drives the real composed runtime against local deterministic
fixtures and writes its normalized evidence JSON into the evidence directory:
``mixed-queue.json``, ``cancel-crash-recover.json``, or ``secret-boundary.json``.
The runner is Windows-only (Job Objects) and exits nonzero on any scenario
failure so manual QA can gate on the exit code.
"""

from __future__ import annotations

import json
import platform
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final, Literal, assert_never

from ._scenarios import run_cancel_crash_recover, run_mixed_queue, run_secret_boundary

if TYPE_CHECKING:
    from collections.abc import Sequence

ScenarioName = Literal["mixed-queue", "cancel-crash-recover", "secret-boundary"]

EVIDENCE_FILENAMES: Final[dict[ScenarioName, str]] = {
    "mixed-queue": "mixed-queue.json",
    "cancel-crash-recover": "cancel-crash-recover.json",
    "secret-boundary": "secret-boundary.json",
}

_USAGE: Final = (
    "usage: python -m hubfetch.scenarios.main --scenario <name> --evidence <dir>"
)
_SCENARIO_NAMES: Final = "mixed-queue, cancel-crash-recover, secret-boundary"
_ARGV_TOKEN_COUNT: Final = 4
_INVALID_ARGV: Final = "expected `--scenario <name> --evidence <dir>`"


@dataclass(frozen=True, slots=True)
class ScenarioArgs:
    """Parsed runner arguments."""

    scenario: ScenarioName
    evidence_dir: Path


def main(argv: Sequence[str] | None = None) -> int:
    """Run one named scenario and write its evidence JSON."""
    raw = tuple(sys.argv[1:] if argv is None else argv)
    try:
        args = _parse_args(raw)
    except ValueError as error:
        _ = sys.stderr.write(f"{error}\n{_USAGE}\n")
        return 2
    if platform.system() != "Windows":
        _ = sys.stderr.write("scenarios require Windows (Job Objects)\n")
        return 2
    try:
        payload = _run_scenario(args.scenario)
    except AssertionError as error:
        _ = sys.stderr.write(f"scenario {args.scenario} failed: {error}\n")
        return 1
    evidence = args.evidence_dir
    evidence.mkdir(parents=True, exist_ok=True)
    path = evidence / EVIDENCE_FILENAMES[args.scenario]
    serialized = json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True)
    _ = path.write_text(f"{serialized}\n", encoding="utf-8")
    _ = sys.stdout.write(f"scenario {args.scenario} passed: {path}\n")
    return 0


def _parse_args(raw: tuple[str, ...]) -> ScenarioArgs:
    """Parse the bounded runner argv or raise a typed usage error."""
    valid_shape = (
        len(raw) == _ARGV_TOKEN_COUNT
        and raw[0] == "--scenario"
        and raw[2] == "--evidence"
    )
    if not valid_shape:
        raise ValueError(_INVALID_ARGV)
    scenario = raw[1]
    match scenario:
        case "mixed-queue" | "cancel-crash-recover" | "secret-boundary" as known:
            return ScenarioArgs(scenario=known, evidence_dir=Path(raw[3]))
        case _:
            message = f"unknown scenario {scenario!r}; choose from: {_SCENARIO_NAMES}"
            raise ValueError(message)


def _run_scenario(name: ScenarioName) -> dict[str, object]:
    """Dispatch one scenario to its implementation by an exhaustive match."""
    match name:
        case "mixed-queue":
            return run_mixed_queue()
        case "cancel-crash-recover":
            return run_cancel_crash_recover()
        case "secret-boundary":
            return run_secret_boundary()
        case _:
            assert_never(name)


if __name__ == "__main__":
    sys.exit(main())
