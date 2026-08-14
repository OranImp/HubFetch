"""Read-only assessment of configured Git credential helpers and Git Credential Manager.

The effective ``credential.helper`` values are read with
``git config --show-origin --get-all``; nothing is ever written. A plaintext
``store`` helper is flagged as unsafe because it persists credentials
unencrypted, and the Git Credential Manager executable and version are probed
read-only. Guidance strings are display-only data, never auto-run.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from enum import StrEnum, unique
from pathlib import Path
from typing import TYPE_CHECKING, Final, final

from hubfetch.diagnostics.git import extract_semver
from hubfetch.git.process_runner import (
    DEFAULT_TIMEOUT_SECONDS,
    CommandLaunchError,
    CommandResult,
    CommandTimeoutError,
    run_command,
)

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

HELPER_PROBE_ARGV: Final = (
    "config",
    "--show-origin",
    "--get-all",
    "credential.helper",
)
_BUNDLED_GCM_CANDIDATE: Final = (
    "C:/Program Files/Git/mingw64/bin/git-credential-manager.exe"
)
_PLAINTEXT_GUIDANCE: Final = (
    "Configure Git Credential Manager instead of the plaintext store helper."
)


@unique
class CredentialHelperState(StrEnum):
    """Outcome of the effective credential helper configuration probe."""

    SAFE = "safe"
    PLAINTEXT_UNSAFE = "plaintext_unsafe"
    NONE = "none"
    UNKNOWN = "unknown"


@unique
class GcmState(StrEnum):
    """Availability of the Git Credential Manager executable."""

    PRESENT = "present"
    MISSING = "missing"


@dataclass(frozen=True, slots=True)
class CredentialCheckerOptions:
    """Read-only probe configuration for credential helpers and GCM."""

    git_command: tuple[str, ...] = ("git",)
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    environment: Mapping[str, str] | None = None
    gcm_candidates: tuple[str, ...] | None = None
    gcm_probe_command: tuple[str, ...] | None = None


@dataclass(frozen=True, slots=True)
class CredentialHelperEntry:
    """One effective credential helper value with its defining config file."""

    value: str
    origin: str | None


@dataclass(frozen=True, slots=True)
class GcmReport:
    """Availability, executable, and version of Git Credential Manager."""

    state: GcmState
    executable: str | None
    version: str | None


@dataclass(frozen=True, slots=True)
class CredentialHelperReport:
    """Complete typed report for configured helpers and GCM availability."""

    state: CredentialHelperState
    helpers: tuple[CredentialHelperEntry, ...]
    gcm: GcmReport
    warning: str | None
    guidance: tuple[str, ...]


def _default_gcm_candidates() -> tuple[str, ...]:
    """Return the standard discovery candidates for the GCM executable."""
    candidates: list[str] = ["git-credential-manager", _BUNDLED_GCM_CANDIDATE]
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        candidates.append(
            str(
                Path(local_app_data)
                / "Programs"
                / "Git Credential Manager"
                / "git-credential-manager.exe"
            )
        )
    return tuple(candidates)


def _resolve_executable(candidates: Sequence[str]) -> str | None:
    """Return the first candidate that is a file or resolves on PATH."""
    for candidate in candidates:
        if Path(candidate).is_file():
            return str(candidate)
        resolved = shutil.which(candidate)
        if resolved is not None:
            return resolved
    return None


def _is_plaintext_helper(value: str) -> bool:
    """Return whether a helper value is the unencrypted ``store`` helper."""
    first_token = value.lstrip("!").strip().split(" ", maxsplit=1)[0]
    return first_token.casefold() == "store"


def _parse_helper_lines(text: str) -> tuple[CredentialHelperEntry, ...]:
    """Parse ``--show-origin --get-all`` output into helper entries."""
    entries: list[CredentialHelperEntry] = []
    for raw_line in text.splitlines():
        line = raw_line.rstrip("\r")
        origin, separator, value = line.partition("\t")
        if not separator:
            value, origin = line, ""
        entries.append(CredentialHelperEntry(value=value, origin=origin or None))
    return tuple(entries)


def _classify_helpers(
    helpers: tuple[CredentialHelperEntry, ...] | None,
) -> tuple[CredentialHelperState, str | None]:
    """Classify helper entries; None means the probe itself failed."""
    if helpers is None:
        return CredentialHelperState.UNKNOWN, None
    plaintext = tuple(
        entry.value for entry in helpers if _is_plaintext_helper(entry.value)
    )
    if plaintext:
        names = ", ".join(plaintext)
        warning = f"Plaintext credential helper configured: {names}. Use GCM instead."
        return CredentialHelperState.PLAINTEXT_UNSAFE, warning
    if not helpers:
        return CredentialHelperState.NONE, None
    return CredentialHelperState.SAFE, None


def _guidance_for_helpers(state: CredentialHelperState) -> tuple[str, ...]:
    """Return display-only guidance for an unsafe helper configuration."""
    match state:
        case CredentialHelperState.PLAINTEXT_UNSAFE:
            return (_PLAINTEXT_GUIDANCE,)
        case CredentialHelperState.SAFE | CredentialHelperState.NONE:
            return ()
        case CredentialHelperState.UNKNOWN:
            return ("Recheck after confirming `git config` works.",)


@final
class CredentialHelperChecker:
    """Probe configured helpers and GCM availability read-only."""

    __slots__: Final = ("_options",)
    _options: CredentialCheckerOptions

    def __init__(self, options: CredentialCheckerOptions | None = None) -> None:
        """Create a checker with the given options or conservative defaults."""
        self._options = options if options is not None else CredentialCheckerOptions()

    def check(self) -> CredentialHelperReport:
        """Run all probes; call again to Recheck after changing helpers."""
        helpers = self._probe_helpers()
        gcm = self._probe_gcm()
        state, warning = _classify_helpers(helpers)
        return CredentialHelperReport(
            state=state,
            helpers=helpers if helpers is not None else (),
            gcm=gcm,
            warning=warning,
            guidance=_guidance_for_helpers(state),
        )

    def _probe_helpers(self) -> tuple[CredentialHelperEntry, ...] | None:
        """Read effective helpers; None means the probe itself failed."""
        argv = (*self._options.git_command, *HELPER_PROBE_ARGV)
        try:
            result = self._run(argv)
        except (CommandLaunchError, CommandTimeoutError):
            return None
        if result.returncode == 1:
            return ()
        if result.returncode != 0:
            return None
        return _parse_helper_lines(result.stdout)

    def _probe_gcm(self) -> GcmReport:
        """Resolve the GCM executable and probe its version read-only."""
        candidates = (
            self._options.gcm_candidates
            if self._options.gcm_candidates is not None
            else _default_gcm_candidates()
        )
        executable = _resolve_executable(candidates)
        if executable is None:
            return GcmReport(state=GcmState.MISSING, executable=None, version=None)
        version = self._probe_gcm_version(executable)
        return GcmReport(state=GcmState.PRESENT, executable=executable, version=version)

    def _probe_gcm_version(self, executable: str) -> str | None:
        """Probe ``<gcm> --version``; a failure only means version unknown."""
        probe = (
            self._options.gcm_probe_command
            if self._options.gcm_probe_command is not None
            else (executable,)
        )
        argv = (*probe, "--version")
        try:
            result = self._run(argv)
        except (CommandLaunchError, CommandTimeoutError):
            return None
        if result.returncode != 0:
            return None
        return extract_semver(result.stdout)

    def _run(self, argv: Sequence[str]) -> CommandResult:
        """Run one bounded read-only probe through the shared runner."""
        return run_command(
            argv,
            timeout_seconds=self._options.timeout_seconds,
            environment=self._options.environment,
        )
