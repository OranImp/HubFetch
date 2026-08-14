"""Tests for the bounded worker argv contract.

The worker command line may carry only the ``--worker`` mode flag and one
opaque, non-secret session locator. These tests lock that shape for both the
development interpreter and the frozen executable, and prove task details
smuggled into argv are rejected at the launch boundary.
"""

from __future__ import annotations

import sys
from typing import Final

import pytest

from hubfetch.runtime.worker_command import (
    WorkerArgvError,
    build_worker_argv,
    parse_worker_argv,
)

HF_TEST_SECRET: Final = "hf_test_secret_123"  # noqa: S105


def test_build_worker_argv_dev_mode_never_carries_task_data() -> None:
    """Given a session locator, dev argv carries only mode flags and the locator."""
    argv = build_worker_argv(session_locator="session-1", frozen=False)

    assert argv[0] == sys.executable
    assert argv[1] == "-u"
    assert argv[2] == "-m"
    assert argv[3] == "hubfetch.worker.main"
    assert argv[4:] == ("--worker", "session-1")
    assert all(HF_TEST_SECRET not in token for token in argv)
    assert all("--task" not in token and "--spec" not in token for token in argv)


def test_build_worker_argv_frozen_mode() -> None:
    """Given a session locator, frozen argv is the packaged executable tail."""
    argv = build_worker_argv(session_locator="session-2", frozen=True)

    assert argv == ("HubFetch.exe", "--worker", "session-2")


def test_parse_worker_argv_accepts_the_bounded_shape() -> None:
    """Given the exact dev tail, the parser returns the session locator."""
    launch = parse_worker_argv(["--worker", "session-3"])

    assert launch.session_locator == "session-3"


def test_parse_worker_argv_rejects_task_details() -> None:
    """Given a token beyond the bounded shape, the parser rejects it."""
    with pytest.raises(WorkerArgvError):
        _ = parse_worker_argv(["--worker", "session-4", "--task", "spec"])
    with pytest.raises(WorkerArgvError):
        _ = parse_worker_argv(["--task", "spec", "--worker", "session-4"])
    with pytest.raises(WorkerArgvError):
        _ = parse_worker_argv(["bogus"])


def test_parse_worker_argv_rejects_empty_or_nul_locator() -> None:
    """Given an empty or NUL-bearing locator, the parser rejects it."""
    with pytest.raises(WorkerArgvError):
        _ = parse_worker_argv(["--worker", ""])
    with pytest.raises(WorkerArgvError):
        _ = parse_worker_argv(["--worker", "a\x00b"])
