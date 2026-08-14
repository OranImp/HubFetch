"""Windows integration tests for the GUI-side worker QProcess transport.

These tests spawn the real development worker and prove ready-before-envelope,
Job assignment-before-release, no pre-assignment side-effect sentinel, typed
protocol failures, and bounded shutdown. The transport is Windows-bound (Job
Objects), so the whole module follows the platform guard used by the Job
Object suite.
"""

from __future__ import annotations

import platform
from typing import TYPE_CHECKING, Final

import pytest

from hubfetch.domain.ipc import ShutdownCommand
from hubfetch.runtime.process_environment import environment_mapping
from hubfetch.runtime.worker_command import build_worker_argv
from tests.runtime.worker_fixtures import (
    HF_TEST_SECRET,
    start_task_command,
    worker_environment,
)

if TYPE_CHECKING:
    from pathlib import Path

    from pytestqt.qtbot import QtBot

if platform.system() != "Windows":
    pytest.skip(allow_module_level=True)

from hubfetch.platform.windows.job_object import JobObject
from hubfetch.runtime.worker_process import WorkerProcess
from tests.runtime.worker_process_fixtures import (
    Recorder,
    launched_worker,
    rogue_argv,
    rogue_early_exit,
    rogue_ready_then_duplicate_terminal,
    rogue_sentinel_before_ready,
    rogue_silent_block,
)

READY_TIMEOUT_MS: Final = 10_000


def test_real_worker_ready_assigned_command_ordering(qtbot: QtBot) -> None:
    """Given the real worker, ready, assignment, and envelope strictly order."""
    environment = worker_environment()
    argv = build_worker_argv(session_locator="qa-session-1", frozen=False)
    recorder = Recorder()
    with launched_worker(argv=argv, environment=environment) as worker:
        _ = worker.ready.connect(recorder.ready)
        _ = worker.assigned.connect(recorder.assigned)
        _ = worker.command_sent.connect(recorder.command)
        _ = worker.preflight_failed.connect(recorder.failure)
        _ = worker.process_exited.connect(recorder.exited)
        _ = worker.stderr_sanitized.connect(recorder.stderr)

        qtbot.waitUntil(lambda: "ready" in recorder.items, timeout=READY_TIMEOUT_MS)
        assert worker.pid is not None
        worker.assign()
        worker.send_envelope(ShutdownCommand())
        qtbot.waitUntil(
            lambda: any(item.startswith("exit:") for item in recorder.items),
            timeout=READY_TIMEOUT_MS,
        )

    assert recorder.items[0] == "ready"
    assert recorder.items[1] == "assigned"
    assert "command:shutdown" in recorder.items
    assert "exit:0" in recorder.items
    assert not any(item.startswith("failed:") for item in recorder.items)
    assert all(HF_TEST_SECRET not in line for line in recorder.stderr_lines)


def test_real_worker_does_no_destination_work_before_assignment(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a released worker, its destination appears only after the envelope."""
    environment = worker_environment()
    argv = build_worker_argv(session_locator="qa-session-2", frozen=False)
    destination = tmp_path / "destination"
    recorder = Recorder()
    with launched_worker(argv=argv, environment=environment) as worker:
        _ = worker.ready.connect(recorder.ready)
        _ = worker.terminal_event.connect(recorder.terminal)
        _ = worker.process_exited.connect(recorder.exited)
        _ = worker.preflight_failed.connect(recorder.failure)

        qtbot.waitUntil(lambda: "ready" in recorder.items, timeout=READY_TIMEOUT_MS)
        assert not destination.exists()
        worker.assign()
        worker.send_envelope(start_task_command(destination))
        qtbot.waitUntil(
            lambda: any(item.startswith("terminal:") for item in recorder.items),
            timeout=READY_TIMEOUT_MS,
        )
        qtbot.waitUntil(
            lambda: any(item.startswith("exit:") for item in recorder.items),
            timeout=READY_TIMEOUT_MS,
        )

    assert destination.exists()
    assert "terminal:failed" in recorder.items
    assert not any(item.startswith("failed:") for item in recorder.items)


def test_worker_touching_sentinel_before_release_is_rejected(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a rogue worker, the transport withholds the envelope and fails."""
    environment = worker_environment()
    sentinel = tmp_path / "sentinel.txt"
    argv = rogue_argv(tmp_path, rogue_sentinel_before_ready(str(sentinel)))
    recorder = Recorder()
    with launched_worker(argv=argv, environment=environment) as worker:
        _ = worker.command_sent.connect(recorder.command)
        _ = worker.preflight_failed.connect(recorder.failure)
        _ = worker.process_exited.connect(recorder.exited)

        qtbot.waitUntil(
            lambda: (
                any(item.startswith("failed:") for item in recorder.items)
                or any(item.startswith("exit:") for item in recorder.items)
            ),
            timeout=READY_TIMEOUT_MS,
        )

    assert "failed:unexpected_before_ready" in recorder.items
    assert sentinel.exists()
    assert not any(item.startswith("command:") for item in recorder.items)


def test_duplicate_terminal_events_are_a_typed_protocol_failure(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a worker with duplicate terminal events, the transport fails typed."""
    environment = worker_environment()
    argv = rogue_argv(tmp_path, rogue_ready_then_duplicate_terminal())
    recorder = Recorder()
    with launched_worker(argv=argv, environment=environment) as worker:
        _ = worker.terminal_event.connect(recorder.terminal)
        _ = worker.command_sent.connect(recorder.command)
        _ = worker.preflight_failed.connect(recorder.failure)

        qtbot.waitUntil(
            lambda: any(item.startswith("failed:") for item in recorder.items),
            timeout=READY_TIMEOUT_MS,
        )

    failures = [item for item in recorder.items if item.startswith("failed:")]
    assert len(failures) == 1
    assert failures[0] in {
        "failed:second_terminal_event",
        "failed:event_after_terminal",
    }
    assert not any(item.startswith("command:") for item in recorder.items)


def test_assignment_failure_withholds_the_envelope(qtbot: QtBot) -> None:
    """Given a closed Job, assignment fails and the envelope is never sent."""
    environment = worker_environment()
    argv = build_worker_argv(session_locator="qa-session-3", frozen=False)
    recorder = Recorder()
    job = JobObject()
    worker = WorkerProcess(
        argv=argv, environment=environment, job=job, ready_timeout_ms=READY_TIMEOUT_MS
    )
    try:
        worker.start()
        _ = worker.ready.connect(recorder.ready)
        _ = worker.command_sent.connect(recorder.command)
        _ = worker.preflight_failed.connect(recorder.failure)
        qtbot.waitUntil(lambda: "ready" in recorder.items, timeout=READY_TIMEOUT_MS)
        job.close()
        worker.assign()
        qtbot.waitUntil(
            lambda: "failed:assignment_failed" in recorder.items,
            timeout=READY_TIMEOUT_MS,
        )
    finally:
        if worker.is_running:
            worker.terminate()
        job.close()

    assert not any(item.startswith("command:") for item in recorder.items)


def test_early_exit_before_ready_is_a_preflight_failure(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a worker exiting before ready, the transport reports early exit."""
    environment = worker_environment()
    argv = rogue_argv(tmp_path, rogue_early_exit())
    recorder = Recorder()
    with launched_worker(argv=argv, environment=environment) as worker:
        _ = worker.command_sent.connect(recorder.command)
        _ = worker.preflight_failed.connect(recorder.failure)

        qtbot.waitUntil(
            lambda: "failed:early_exit" in recorder.items, timeout=READY_TIMEOUT_MS
        )

    assert not any(item.startswith("command:") for item in recorder.items)


def test_ready_timeout_is_a_preflight_failure(qtbot: QtBot, tmp_path: Path) -> None:
    """Given a worker that never emits ready, the transport reports a timeout."""
    environment = worker_environment()
    argv = rogue_argv(tmp_path, rogue_silent_block())
    recorder = Recorder()
    with launched_worker(
        argv=argv, environment=environment, ready_timeout_ms=500
    ) as worker:
        _ = worker.command_sent.connect(recorder.command)
        _ = worker.preflight_failed.connect(recorder.failure)

        qtbot.waitUntil(
            lambda: "failed:ready_timeout" in recorder.items, timeout=READY_TIMEOUT_MS
        )

    assert not any(item.startswith("command:") for item in recorder.items)


def test_real_worker_env_and_argv_absence_with_poisoned_parent(
    qtbot: QtBot,
) -> None:
    """Given a poisoned parent, the real worker still completes a clean handshake."""
    environment = worker_environment()
    argv = build_worker_argv(session_locator="qa-session-4", frozen=False)
    values = environment_mapping(environment)
    recorder = Recorder()
    with launched_worker(argv=argv, environment=environment) as worker:
        _ = worker.ready.connect(recorder.ready)
        _ = worker.preflight_failed.connect(recorder.failure)
        _ = worker.process_exited.connect(recorder.exited)

        qtbot.waitUntil(lambda: "ready" in recorder.items, timeout=READY_TIMEOUT_MS)
        worker.assign()
        worker.send_envelope(ShutdownCommand())
        qtbot.waitUntil(
            lambda: any(item.startswith("exit:") for item in recorder.items),
            timeout=READY_TIMEOUT_MS,
        )

    assert "exit:0" in recorder.items
    assert not any(item.startswith("failed:") for item in recorder.items)
    joined_env = "".join(f"{name}={value}" for name, value in values.items())
    assert HF_TEST_SECRET not in joined_env
    assert HF_TEST_SECRET not in " ".join(argv)
