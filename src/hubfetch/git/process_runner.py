"""Bounded subprocess execution with typed failures for dependency probes.

System Git and Git-Xet are probed read-only through this single runner. The
runner owns the only :mod:`subprocess` call in the diagnostics stack, applies
a bounded timeout, and classifies spawn failures and timeouts as typed
exceptions while returning nonzero exit codes as data so probes can classify
them themselves.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

DEFAULT_TIMEOUT_SECONDS: Final = 30.0
"""Conservative bound for every diagnostic probe on a local tool."""


class EmptyCommandError(ValueError):
    """Raised when :func:`run_command` receives no executable name."""

    def __init__(self) -> None:
        """Report the empty argv contract violation."""
        super().__init__("argv must name an executable")


class CommandLaunchError(RuntimeError):
    """Raised when the executable cannot be spawned (missing or not runnable)."""

    __slots__: Final = ("argv",)
    argv: tuple[str, ...]

    def __init__(self, argv: Sequence[str], reason: str) -> None:
        """Record the attempted argv and the underlying spawn reason."""
        self.argv = tuple(argv)
        super().__init__(f"cannot launch {self.argv[0]!r}: {reason}")


class CommandTimeoutError(TimeoutError):
    """Raised when a probe exceeds its bounded timeout and was terminated."""

    __slots__: Final = ("argv", "timeout_seconds")
    argv: tuple[str, ...]
    timeout_seconds: float

    def __init__(self, argv: Sequence[str], timeout_seconds: float) -> None:
        """Record the attempted argv and the applied timeout bound."""
        self.argv = tuple(argv)
        self.timeout_seconds = timeout_seconds
        super().__init__(f"command timed out after {timeout_seconds:g} seconds")


@dataclass(frozen=True, slots=True)
class CommandResult:
    """Captured outcome of one bounded subprocess run."""

    argv: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str


def run_command(
    argv: Sequence[str],
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    environment: Mapping[str, str] | None = None,
) -> CommandResult:
    """Run one command with a bounded timeout and return its captured result.

    The executable is resolved by the operating system and no shell is
    involved. A nonzero exit code is reported in :class:`CommandResult` and is
    never raised here so probes can classify exit codes themselves. Raises
    :class:`CommandLaunchError` when the executable cannot be spawned and
    :class:`CommandTimeoutError` when the bound expires after the child has
    been terminated.
    """
    if not argv:
        raise EmptyCommandError
    try:
        completed = subprocess.run(  # noqa: S603
            list(argv),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
            env=dict(environment) if environment is not None else None,
        )
    except subprocess.TimeoutExpired as error:
        raise CommandTimeoutError(argv, timeout_seconds) from error
    except OSError as error:
        raise CommandLaunchError(argv, str(error)) from error
    return CommandResult(
        argv=tuple(argv),
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )
