"""Preflighted, streaming Git working-copy clones with typed outcomes.

Runs the Todo 12 readiness probe, requires an absent or empty destination,
streams ``git clone --progress`` stderr through the Todo 19 progress parser,
and maps exit codes and stderr categories to Todo 6 typed errors. Never uses
a shell, mutates global Git config, resumes in place, or deletes a failed
partial directory. On Windows the git process inherits the worker's Job
Object so descendants stay contained.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, final

from hubfetch.diagnostics.git import (
    GitCheckerOptions,
    GitDependencyChecker,
    ToolProbeState,
)
from hubfetch.domain.errors import ErrorCategory, HubFetchError, error_for
from hubfetch.git.clone_command import CloneOptions, build_clone_argv, clone_environment
from hubfetch.git.progress import GitProgressRecord, parse_progress_line
from hubfetch.security.redaction import Redactor

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator, Mapping
    from pathlib import Path

_READ_CHUNK_BYTES: Final = 65536

_AUTHENTICATION_MARKERS: Final = (
    "authentication failed",
    "could not read username",
    "could not read password",
    "permission denied (publickey)",
)
_GATED_MARKERS: Final = ("access to repository", "is disabled")
_XET_MARKERS: Final = (
    "external filter 'git-xet filter' failed",
    "filter 'xet' failed",
)
_NOT_FOUND_MARKERS: Final = (
    "not found",
    "does not appear to be a git repository",
    "could not read from remote repository",
)
_NETWORK_MARKERS: Final = (
    "unable to access",
    "could not resolve host",
    "failed to connect",
    "connection timed out",
    "connection refused",
    "early eof",
    "the remote end hung up unexpectedly",
    "rpc failed",
    "the requested url returned error: 5",
)
_DISK_MARKERS: Final = (
    "no space left on device",
    "cannot create directory",
    "already exists and is not an empty directory",
)


@dataclass(frozen=True, slots=True)
class CloneOutcome:
    """Result of one successful working-copy clone."""

    destination: Path
    records: tuple[GitProgressRecord, ...]
    diagnostics: tuple[str, ...]


@final
class GitCloner:
    """Clone one repository into an empty or absent destination."""

    __slots__: Final = ("_base_environment", "_checker", "_git_command", "_redactor")

    def __init__(
        self,
        *,
        git_command: tuple[str, ...] = ("git",),
        environment: Mapping[str, str] | None = None,
        checker: GitDependencyChecker | None = None,
        redactor: Redactor | None = None,
    ) -> None:
        """Own the git command, environment, readiness checker, and redactor."""
        self._git_command = git_command
        self._base_environment = (
            dict(environment) if environment is not None else dict(os.environ)
        )
        self._checker = (
            checker
            if checker is not None
            else GitDependencyChecker(
                GitCheckerOptions(
                    git_command=git_command, environment=self._base_environment
                )
            )
        )
        self._redactor = redactor if redactor is not None else Redactor()

    def clone(
        self,
        url: str,
        destination: Path,
        options: CloneOptions | None = None,
        *,
        cancel: Callable[[], bool] | None = None,
        on_progress: Callable[[GitProgressRecord], None] | None = None,
    ) -> CloneOutcome:
        """Preflight and run one working-copy clone, streaming typed progress."""
        self._preflight(destination)
        if cancel is not None and cancel():
            raise error_for(ErrorCategory.CANCELLATION, detail="clone was cancelled")
        argv = build_clone_argv(
            url, destination, options, git_command=self._git_command
        )
        process: subprocess.Popen[str] = subprocess.Popen(  # noqa: S603
            list(argv),
            env=clone_environment(self._base_environment),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        stderr = process.stderr
        if stderr is None:
            raise error_for(
                ErrorCategory.INTERNAL, detail="git stderr pipe is unavailable"
            )
        stream_fd: int = stderr.fileno()
        records: list[GitProgressRecord] = []
        raw_diagnostics: list[str] = []
        try:
            for raw_line in _read_lines(stream_fd):
                if cancel is not None and cancel():
                    _terminate_tree(process)
                    raise error_for(
                        ErrorCategory.CANCELLATION, detail="clone was cancelled"
                    )
                record = parse_progress_line(raw_line)
                if record is not None:
                    records.append(record)
                    if on_progress is not None:
                        on_progress(record)
                else:
                    raw_diagnostics.append(raw_line.rstrip("\r\n"))
            returncode = process.wait()
        finally:
            _ = stderr.close()
        if returncode != 0:
            raise self._classify(returncode, "\n".join(raw_diagnostics))
        return CloneOutcome(
            destination=destination,
            records=tuple(records),
            diagnostics=tuple(
                self._redactor.redact_text(line) for line in raw_diagnostics
            ),
        )

    def _preflight(self, destination: Path) -> None:
        report = self._checker.check()
        if report.git_state is not ToolProbeState.INSTALLED:
            guidance = "; ".join(report.guidance) or "install Git"
            raise error_for(
                ErrorCategory.DEPENDENCY, detail=f"Git is not ready: {guidance}"
            )
        if not destination.exists():
            destination.mkdir(parents=True, exist_ok=True)
            return
        if destination.is_dir():
            if any(destination.iterdir()):
                raise error_for(
                    ErrorCategory.DISK,
                    detail=f"destination is not empty: {destination}",
                )
            return
        raise error_for(
            ErrorCategory.DISK,
            detail=f"destination is not a directory: {destination}",
        )

    def _classify(self, returncode: int, stderr_text: str) -> HubFetchError:
        detail = stderr_text or f"git clone exited {returncode}"
        return error_for(_classify_category(stderr_text.casefold()), detail=detail)


def _classify_category(folded: str) -> ErrorCategory:
    """Return the typed category for one failed clone's folded stderr."""
    checks: tuple[tuple[tuple[str, ...], bool, ErrorCategory], ...] = (
        (_GATED_MARKERS, True, ErrorCategory.GATED_ACCESS),
        (_AUTHENTICATION_MARKERS, False, ErrorCategory.AUTHENTICATION),
        (_XET_MARKERS, False, ErrorCategory.DEPENDENCY),
        (_NOT_FOUND_MARKERS, False, ErrorCategory.NOT_FOUND),
        (_NETWORK_MARKERS, False, ErrorCategory.NETWORK),
        (_DISK_MARKERS, False, ErrorCategory.DISK),
    )
    for markers, require_all, category in checks:
        matched = (
            all(marker in folded for marker in markers)
            if require_all
            else any(marker in folded for marker in markers)
        )
        if matched:
            return category
    return ErrorCategory.INTERNAL


def _read_lines(stream_fd: int) -> Iterator[str]:
    r"""Yield stderr fragments, splitting Git's carriage-return progress updates.

    Reading through the descriptor avoids subprocess's ``IO[Any]`` wrapper so
    every fragment is typed ``str``; empty fragments are dropped.
    """
    buffer = ""
    while True:
        chunk = os.read(stream_fd, _READ_CHUNK_BYTES)
        if not chunk:
            break
        buffer += chunk.decode("utf-8", errors="replace")
        while "\n" in buffer or "\r" in buffer:
            index = _first_separator(buffer)
            if index == -1:
                break
            line = buffer[:index]
            buffer = buffer[index + 1 :]
            if line:
                yield line
    if buffer:
        yield buffer


def _first_separator(text: str) -> int:
    newline = text.find("\n")
    carriage_return = text.find("\r")
    if newline == -1:
        return carriage_return
    if carriage_return == -1:
        return newline
    return min(newline, carriage_return)


def _terminate_tree(process: subprocess.Popen[str]) -> None:
    """Terminate a git process tree within a bounded wait (no orphan).

    ``taskkill /T`` also removes short-lived helper children (credential or
    transport helpers) so cooperative cancellation never leaves a descendant.
    """
    if process.poll() is not None:
        return
    if shutil.which("taskkill") is not None:
        _ = subprocess.run(  # noqa: S603
            [
                shutil.which("taskkill") or "taskkill",
                "/PID",
                str(process.pid),
                "/T",
                "/F",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30.0,
        )
    else:
        process.kill()
    try:
        _ = process.wait(timeout=30.0)
    except subprocess.TimeoutExpired:
        process.kill()
