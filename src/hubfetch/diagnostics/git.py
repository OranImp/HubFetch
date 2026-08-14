"""Read-only assessment of system Git and Git-Xet dependency readiness.

Every probe is a bounded subprocess that only reads: ``git --version``,
``git xet --version``, and ``git config --show-origin --get-regexp`` for the
effective Xet filter configuration. No command here can mutate configuration,
and the checker never invokes ``git xet install`` or edits any Git config
file. Guidance strings are display-only data for the user; the ``check``
method is the Recheck action and can be invoked again after installation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum, unique
from typing import TYPE_CHECKING, Final, final

from hubfetch.git.process_runner import (
    DEFAULT_TIMEOUT_SECONDS,
    CommandLaunchError,
    CommandResult,
    CommandTimeoutError,
    run_command,
)

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

_SEMVER_PATTERN: Final = re.compile(r"\b\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?\b")
_XET_FILTER_REGEXP: Final = r"^filter\.xet\."
_MISSING_SUBCOMMAND_MARKER: Final = "not a git command"

GIT_INSTALL_GUIDANCE: Final = "winget install --id Git.Git -e"
XET_INSTALL_GUIDANCE: Final = "winget install --id git-xet.git-xet -e"
XET_INIT_GUIDANCE: Final = (
    "Run `git xet install` in a terminal to register the Xet filters, then Recheck."
)


@unique
class DependencyState(StrEnum):
    """Overall readiness of the Git toolchain for Xet-enabled clones."""

    READY = "ready"
    DEGRADED = "degraded"
    BLOCKED = "blocked"


@unique
class ToolProbeState(StrEnum):
    """Outcome of one version-command probe."""

    INSTALLED = "installed"
    MISSING = "missing"
    TIMEOUT = "timeout"
    NONZERO = "nonzero"


@unique
class XetState(StrEnum):
    """Outcome of the Git-Xet subcommand and filter configuration probes."""

    CONFIGURED = "configured"
    UNINITIALIZED = "uninitialized"
    MISSING = "missing"
    TIMEOUT = "timeout"
    NONZERO = "nonzero"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class GitCheckerOptions:
    """Read-only probe configuration for system Git and Git-Xet."""

    git_command: tuple[str, ...] = ("git",)
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    environment: Mapping[str, str] | None = None


@dataclass(frozen=True, slots=True)
class XetFilterConfig:
    """One effective Xet filter entry with the config file that defines it."""

    key: str
    value: str
    origin: str


@dataclass(frozen=True, slots=True)
class GitProbe:
    """Typed result of the ``git --version`` probe."""

    state: ToolProbeState
    version: str | None
    detail: str


@dataclass(frozen=True, slots=True)
class XetProbe:
    """Typed result of the Git-Xet subcommand and filter probes."""

    state: XetState
    version: str | None
    filters: tuple[XetFilterConfig, ...]
    detail: str


@dataclass(frozen=True, slots=True)
class GitDependencyReport:
    """Complete typed readiness report for system Git and Git-Xet."""

    git_state: ToolProbeState
    git_version: str | None
    xet: XetProbe
    state: DependencyState
    guidance: tuple[str, ...]


def extract_semver(text: str) -> str | None:
    """Return the first semantic version token captured from command output."""
    match = _SEMVER_PATTERN.search(text)
    return match.group(0) if match is not None else None


def _combined_output(result: CommandResult) -> str:
    """Return captured stdout and stderr joined for diagnostic detail."""
    return "\n".join(part for part in (result.stdout, result.stderr) if part)


def _parse_origin_key_value_lines(text: str) -> tuple[XetFilterConfig, ...]:
    """Parse ``--show-origin --get-regexp`` output into filter entries."""
    entries: list[XetFilterConfig] = []
    for raw_line in text.splitlines():
        line = raw_line.rstrip("\r")
        origin, separator, rest = line.partition("\t")
        if not separator:
            rest, origin = line, ""
        key, _, value = rest.partition(" ")
        entries.append(XetFilterConfig(key=key, value=value, origin=origin))
    return tuple(entries)


def _guidance_for_git(state: ToolProbeState) -> tuple[str, ...]:
    """Return display-only guidance for an unusable Git probe."""
    match state:
        case ToolProbeState.MISSING:
            return (GIT_INSTALL_GUIDANCE,)
        case ToolProbeState.TIMEOUT:
            return ("Recheck after confirming `git --version` returns promptly.",)
        case ToolProbeState.NONZERO:
            return ("Recheck after confirming `git --version` exits successfully.",)
        case ToolProbeState.INSTALLED:
            return ()


def _guidance_for_xet(state: XetState) -> tuple[str, ...]:
    """Return display-only guidance for a Git-Xet probe state."""
    match state:
        case XetState.MISSING:
            return (XET_INSTALL_GUIDANCE,)
        case XetState.UNINITIALIZED:
            return (XET_INIT_GUIDANCE,)
        case XetState.TIMEOUT:
            return ("Recheck after confirming `git xet --version` returns promptly.",)
        case XetState.NONZERO:
            return ("Recheck after confirming `git xet --version` exits successfully.",)
        case XetState.UNKNOWN:
            return ("Recheck to retry the Xet filter probe.",)
        case XetState.CONFIGURED:
            return ()


@final
class GitDependencyChecker:
    """Run read-only Git and Git-Xet probes and produce a typed report."""

    __slots__: Final = ("_options",)
    _options: GitCheckerOptions

    def __init__(self, options: GitCheckerOptions | None = None) -> None:
        """Create a checker with the given options or conservative defaults."""
        self._options = options if options is not None else GitCheckerOptions()

    def check(self) -> GitDependencyReport:
        """Run all probes; call again to Recheck after installing tools."""
        git = self._probe_git_version()
        if git.state is not ToolProbeState.INSTALLED:
            return GitDependencyReport(
                git_state=git.state,
                git_version=None,
                xet=XetProbe(
                    state=XetState.UNKNOWN,
                    version=None,
                    filters=(),
                    detail="Git-Xet was not probed because Git is unusable.",
                ),
                state=DependencyState.BLOCKED,
                guidance=_guidance_for_git(git.state),
            )
        xet = self._probe_xet()
        return GitDependencyReport(
            git_state=git.state,
            git_version=git.version,
            xet=xet,
            state=(
                DependencyState.READY
                if xet.state is XetState.CONFIGURED
                else DependencyState.DEGRADED
            ),
            guidance=_guidance_for_xet(xet.state),
        )

    def _probe_git_version(self) -> GitProbe:
        """Probe ``git --version`` and classify the typed outcome."""
        argv = (*self._options.git_command, "--version")
        try:
            result = self._run(argv)
        except CommandLaunchError:
            return GitProbe(state=ToolProbeState.MISSING, version=None, detail="")
        except CommandTimeoutError:
            return GitProbe(state=ToolProbeState.TIMEOUT, version=None, detail="")
        detail = _combined_output(result)
        if result.returncode != 0:
            return GitProbe(state=ToolProbeState.NONZERO, version=None, detail=detail)
        return GitProbe(
            state=ToolProbeState.INSTALLED,
            version=extract_semver(result.stdout),
            detail=detail,
        )

    def _probe_xet(self) -> XetProbe:
        """Probe ``git xet --version`` and the effective Xet filter config."""
        argv = (*self._options.git_command, "xet", "--version")
        try:
            result = self._run(argv)
        except CommandLaunchError:
            return XetProbe(state=XetState.MISSING, version=None, filters=(), detail="")
        except CommandTimeoutError:
            return XetProbe(state=XetState.TIMEOUT, version=None, filters=(), detail="")
        detail = _combined_output(result)
        if result.returncode != 0:
            missing = _MISSING_SUBCOMMAND_MARKER in detail.casefold()
            state = XetState.MISSING if missing else XetState.NONZERO
            return XetProbe(state=state, version=None, filters=(), detail=detail)
        version = extract_semver(result.stdout)
        filters = self._probe_xet_filters()
        if filters is None:
            return XetProbe(
                state=XetState.UNKNOWN, version=version, filters=(), detail=detail
            )
        if filters:
            return XetProbe(
                state=XetState.CONFIGURED,
                version=version,
                filters=filters,
                detail=detail,
            )
        return XetProbe(
            state=XetState.UNINITIALIZED, version=version, filters=(), detail=detail
        )

    def _probe_xet_filters(self) -> tuple[XetFilterConfig, ...] | None:
        """Read the effective ``filter.xet.*`` config; None means probe failed."""
        argv = (
            *self._options.git_command,
            "config",
            "--show-origin",
            "--get-regexp",
            _XET_FILTER_REGEXP,
        )
        try:
            result = self._run(argv)
        except (CommandLaunchError, CommandTimeoutError):
            return None
        if result.returncode == 1:
            return ()
        if result.returncode != 0:
            return None
        return _parse_origin_key_value_lines(result.stdout)

    def _run(self, argv: Sequence[str]) -> CommandResult:
        """Run one bounded read-only probe through the shared runner."""
        return run_command(
            argv,
            timeout_seconds=self._options.timeout_seconds,
            environment=self._options.environment,
        )
