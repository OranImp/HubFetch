"""Bounded worker launch arguments: mode flags and a session locator only.

The worker command line is the argv boundary of the contained handshake:
it may carry only the ``--worker`` mode flag and one opaque, non-secret
session locator. Task specifications and secret material are never placed in
argv; they travel only inside the typed command envelope over stdin after the
GUI has assigned the process to its Job. The parser accepts exactly this
bounded shape and rejects anything else, so task details smuggled into argv
are a launch failure instead of a silent accept.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, override

if TYPE_CHECKING:
    from collections.abc import Sequence

WORKER_FLAG: Final = "--worker"
"""Mode flag that selects the worker entry point in frozen builds."""
FROZEN_EXECUTABLE: Final = "HubFetch.exe"
"""Executable name of the PyInstaller frozen GUI bundle."""
ARGV_TOKEN_COUNT: Final = 2
"""Exact token count of the ``--worker <session-locator>`` tail shape."""


@dataclass(frozen=True, slots=True)
class WorkerLaunch:
    """The parsed, bounded worker launch: one opaque session locator."""

    session_locator: str


@dataclass(frozen=True, slots=True)
class WorkerArgvError(ValueError):
    """The worker argv violated the bounded mode-flags-only contract."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid worker argv: {self.reason}"


def build_worker_argv(*, session_locator: str, frozen: bool) -> tuple[str, ...]:
    """Build the bounded worker argv for the given packaging mode.

    Development builds run the module through the current interpreter with
    unbuffered output; frozen builds run the packaged executable. The returned
    argv never contains task specification or secret data.
    """
    if frozen:
        return (FROZEN_EXECUTABLE, WORKER_FLAG, session_locator)
    return (
        sys.executable,
        "-u",
        "-m",
        "hubfetch.worker.main",
        WORKER_FLAG,
        session_locator,
    )


def parse_worker_argv(argv: Sequence[str]) -> WorkerLaunch:
    """Parse exactly ``--worker <session-locator>``, rejecting any extra tokens.

    ``argv`` is expected to be ``sys.argv[1:]`` so the interpreter prefix and
    ``-m`` token are already consumed; the frozen executable and the module
    entry point therefore share one identical tail shape.
    """
    values = tuple(argv)
    if len(values) != ARGV_TOKEN_COUNT or values[0] != WORKER_FLAG:
        raise WorkerArgvError(reason="expected exactly `--worker <session-locator>`")
    locator = values[1]
    if not locator:
        raise WorkerArgvError(reason="the session locator is empty")
    if "\x00" in locator:
        raise WorkerArgvError(reason="the session locator contains a NUL character")
    return WorkerLaunch(session_locator=locator)
