"""Tests for read-only system Git and Git-Xet dependency assessment."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

import pytest

from hubfetch.diagnostics.git import (
    DependencyState,
    GitCheckerOptions,
    GitDependencyChecker,
    ToolProbeState,
    XetState,
)
from hubfetch.git.process_runner import run_command
from tests.diagnostics.conftest import (
    FILTER_CONFIGURED_HANDLER,
    FILTER_EMPTY_HANDLER,
    GIT_VERSION_HANDLER,
    XET_VERSION_HANDLER,
    FakeHandler,
    make_git_options,
    read_recorded_argv,
    write_fake_git,
)

if TYPE_CHECKING:
    from pathlib import Path

FILTER_LINES: str = (
    "file:/etc/gitconfig\tfilter.xet.process git-xet filter\n"
    "file:/etc/gitconfig\tfilter.xet.smudge git-xet smudge -- %f\n"
)


def test_ready_when_git_xet_and_filters_are_configured(tmp_path: Path) -> None:
    """Given installed git, git-xet, and Xet filters, readiness is reported."""
    script, behavior = write_fake_git(
        tmp_path,
        handlers=(
            GIT_VERSION_HANDLER,
            XET_VERSION_HANDLER,
            FakeHandler(
                ("config", "--show-origin", "--get-regexp", r"^filter\.xet\."),
                output=FILTER_LINES,
            ),
        ),
    )

    report = GitDependencyChecker(make_git_options(script, behavior)).check()

    assert report.git_state is ToolProbeState.INSTALLED
    assert report.git_version == "2.54.0.windows.1"
    assert report.xet.state is XetState.CONFIGURED
    assert report.xet.version == "0.2.1"
    assert len(report.xet.filters) == 2
    assert report.xet.filters[0].key == "filter.xet.process"
    assert report.xet.filters[0].origin == "file:/etc/gitconfig"
    assert report.state is DependencyState.READY
    assert report.guidance == ()


def test_git_missing_blocks_with_install_guidance(tmp_path: Path) -> None:
    """Given git cannot be launched, the report is blocked with guidance."""
    missing = tmp_path / "does-not-exist-git.exe"
    options = GitCheckerOptions(git_command=(str(missing),), timeout_seconds=0.5)

    report = GitDependencyChecker(options).check()

    assert report.git_state is ToolProbeState.MISSING
    assert report.git_version is None
    assert report.xet.state is XetState.UNKNOWN
    assert report.state is DependencyState.BLOCKED
    assert "winget install --id Git.Git -e" in report.guidance


def test_git_timeout_is_bounded_and_reported(tmp_path: Path) -> None:
    """Given a hanging git, the bounded timeout terminates and reports timeout."""
    script, behavior = write_fake_git(
        tmp_path,
        handlers=(GIT_VERSION_HANDLER,),
        delay=5.0,
    )

    started = time.monotonic()
    report = GitDependencyChecker(make_git_options(script, behavior)).check()
    elapsed = time.monotonic() - started

    assert report.git_state is ToolProbeState.TIMEOUT
    assert report.state is DependencyState.BLOCKED
    assert elapsed < 5.0


def test_git_nonzero_exit_is_blocked(tmp_path: Path) -> None:
    """Given git --version exits nonzero, the report is blocked."""
    script, behavior = write_fake_git(
        tmp_path,
        handlers=(
            FakeHandler(("--version",), error="fatal: unknown error\n", exit_code=3),
        ),
    )

    report = GitDependencyChecker(make_git_options(script, behavior)).check()

    assert report.git_state is ToolProbeState.NONZERO
    assert report.state is DependencyState.BLOCKED


def test_xet_missing_subcommand_is_degraded(tmp_path: Path) -> None:
    """Given git xet reports a missing subcommand, git-xet is missing."""
    script, behavior = write_fake_git(
        tmp_path,
        handlers=(
            GIT_VERSION_HANDLER,
            FakeHandler(
                ("xet", "--version"),
                error="git: 'xet' is not a git command. See 'git --help'.\n",
                exit_code=1,
            ),
        ),
    )

    report = GitDependencyChecker(make_git_options(script, behavior)).check()

    assert report.git_state is ToolProbeState.INSTALLED
    assert report.xet.state is XetState.MISSING
    assert report.state is DependencyState.DEGRADED
    assert "winget install --id git-xet.git-xet -e" in report.guidance


def test_xet_nonzero_exit_is_degraded(tmp_path: Path) -> None:
    """Given git xet fails without the missing-command marker, it is nonzero."""
    script, behavior = write_fake_git(
        tmp_path,
        handlers=(
            GIT_VERSION_HANDLER,
            FakeHandler(
                ("xet", "--version"), error="fatal: xet crashed\n", exit_code=2
            ),
        ),
    )

    report = GitDependencyChecker(make_git_options(script, behavior)).check()

    assert report.git_state is ToolProbeState.INSTALLED
    assert report.xet.state is XetState.NONZERO
    assert report.state is DependencyState.DEGRADED


def test_xet_uninitialized_filters_are_degraded(tmp_path: Path) -> None:
    """Given git-xet installed but filters unregistered, the state is uninitialized."""
    script, behavior = write_fake_git(
        tmp_path,
        handlers=(GIT_VERSION_HANDLER, XET_VERSION_HANDLER, FILTER_EMPTY_HANDLER),
    )

    report = GitDependencyChecker(make_git_options(script, behavior)).check()

    assert report.xet.state is XetState.UNINITIALIZED
    assert report.xet.version == "0.2.1"
    assert report.xet.filters == ()
    assert report.state is DependencyState.DEGRADED
    assert "git xet install" in report.guidance[0]


def test_malformed_version_output_captures_no_version(tmp_path: Path) -> None:
    """Given git prints no semantic version, the version is captured as None."""
    script, behavior = write_fake_git(
        tmp_path,
        handlers=(FakeHandler(("--version",), output="weird build output\n"),),
    )

    report = GitDependencyChecker(make_git_options(script, behavior)).check()

    assert report.git_state is ToolProbeState.INSTALLED
    assert report.git_version is None


def test_all_probe_commands_are_read_only(tmp_path: Path) -> None:
    """Given a full check, every invoked command is a read-only probe."""
    record = tmp_path / "argv.log"
    script, behavior = write_fake_git(
        tmp_path,
        handlers=(GIT_VERSION_HANDLER, XET_VERSION_HANDLER, FILTER_CONFIGURED_HANDLER),
        record=record,
    )

    _ = GitDependencyChecker(make_git_options(script, behavior)).check()

    recorded = read_recorded_argv(record)
    assert recorded == (
        ("--version",),
        ("xet", "--version"),
        ("config", "--show-origin", "--get-regexp", r"^filter\.xet\."),
    )


@pytest.mark.windows
@pytest.mark.integration
def test_real_git_readiness_probe_is_read_only_and_typed() -> None:
    """Given the real system Git, a full check stays read-only and typed."""
    before = run_command(("git", "config", "--list", "--show-origin")).stdout
    report = GitDependencyChecker().check()
    after = run_command(("git", "config", "--list", "--show-origin")).stdout

    assert report.git_state in {
        ToolProbeState.INSTALLED,
        ToolProbeState.MISSING,
        ToolProbeState.TIMEOUT,
        ToolProbeState.NONZERO,
    }
    assert report.xet.state in {
        XetState.CONFIGURED,
        XetState.UNINITIALIZED,
        XetState.MISSING,
        XetState.TIMEOUT,
        XetState.NONZERO,
        XetState.UNKNOWN,
    }
    assert report.state is not None
    if report.git_state is ToolProbeState.INSTALLED:
        assert report.git_version is not None
    assert after == before
