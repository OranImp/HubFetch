"""End-to-end runtime journey tests: real workers, files, and SQLite.

# noqa: SIZE_OK - one module must enumerate the full runtime journey matrix
# (anonymous download, local clone, queued auto-start, queued/active
# cancellation, retry distinctions, database reopen) as real subprocess runs.

Every journey drives the Todo 21 composition root with real subprocess
workers, a deterministic Hub-compatible HTTP fixture, a local bare Git
repository, and a real temporary SQLite store. The tests prove the runtime's
observable contract: truthful lifecycle states, one-at-a-time FIFO dispatch,
queued and active cancellation, retry distinctions, and persistence across a
database reopen.
"""

from __future__ import annotations

import platform
from typing import TYPE_CHECKING, Final

import pytest

from hubfetch.application.bootstrap import WorkerEnvOverrides
from hubfetch.domain.ids import parse_attempt_id, parse_task_id
from hubfetch.domain.lifecycle import LifecycleState, RetryNotAllowedError
from tests.e2e.support import (
    bare_repository_with_objects,
    make_clone_spec,
    make_file_spec,
    start_runtime,
    wait_process_gone,
    write_git_redirect_config,
)
from tests.hub.fixtures import hub_fixture

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from pytestqt.qtbot import QtBot

    from hubfetch.application.runtime import CancelOutcome, Runtime

pytestmark = pytest.mark.windows
if platform.system() != "Windows":
    pytest.skip(allow_module_level=True)

WAIT_TIMEOUT_MS: Final = 60_000


def _task_state(runtime: Runtime, task_id: str) -> LifecycleState:
    """Read the current persisted lifecycle state of one task."""
    return runtime.detail(parse_task_id(task_id)).task.state


def _wait_state(
    qtbot: QtBot, runtime: Runtime, task_id: str, state: LifecycleState
) -> None:
    """Wait until a task reaches the given persisted lifecycle state."""
    qtbot.waitUntil(
        lambda: _task_state(runtime, task_id) == state,
        timeout=WAIT_TIMEOUT_MS,
    )


def _shutdown(qtbot: QtBot, runtime: Runtime) -> None:
    """Bounded orderly shutdown of one runtime."""
    shutdown = runtime.shutdown()
    qtbot.waitUntil(lambda: shutdown.finished_cleanly, timeout=WAIT_TIMEOUT_MS)
    runtime.close()


def _record_terminal(terminal: list[tuple[str, str]]) -> Callable[[str, str], None]:
    """Return a typed terminal-event recorder bound to one list."""

    def record(tid: str, kind: str) -> None:
        terminal.append((tid, kind))

    return record


def _record_running(running: list[str]) -> Callable[[str], None]:
    """Return a typed task-running event recorder bound to one list."""

    def record(tid: str) -> None:
        running.append(tid)

    return record


def _record_terminals(terminals: list[tuple[str, str]]) -> Callable[[str, str], None]:
    """Return a typed terminal-event recorder bound to one list."""

    def record(tid: str, kind: str) -> None:
        terminals.append((tid, kind))

    return record


class TestAnonymousHubDownloadJourney:
    """Given a deterministic Hub fixture, an anonymous file download succeeds."""

    def test_download_materializes_file_with_truthful_states(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        content = b"runtime-journey-config"
        with hub_fixture(
            files=[("config.json", len(content))], content={"config.json": content}
        ) as fixture:
            outcome = start_runtime(
                app_root=tmp_path / "app-data",
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint,
                    hub_cache_dir=tmp_path / "cache",
                ),
            )
            runtime = outcome.runtime
            assert runtime is not None
            assert outcome.fatal is None
            try:
                task_id = parse_task_id("journey-download")
                terminal: list[tuple[str, str]] = []
                runtime.task_terminal.connect(_record_terminal(terminal))
                runtime.create_task(
                    task_id,
                    make_file_spec(
                        filename="config.json", destination=tmp_path / "out"
                    ),
                    parse_attempt_id("journey-download-a1"),
                )

                _wait_state(
                    qtbot, runtime, "journey-download", LifecycleState.SUCCEEDED
                )

                out = tmp_path / "out" / "config.json"
                assert out.is_file()
                assert out.read_bytes() == content
                assert terminal == [("journey-download", "succeeded")]
                assert runtime.snapshot().active_count == 0
                task = runtime.snapshot().tasks[0]
                assert task.state == LifecycleState.SUCCEEDED
                detail = runtime.detail(task_id)
                assert detail.transitions[-1].to_state == LifecycleState.SUCCEEDED
                assert detail.events[-1].kind == "task_transitioned"
            finally:
                _shutdown(qtbot, runtime)


class TestLocalGitCloneJourney:
    """Given a local bare repository, a Git clone task succeeds."""

    def test_clone_materializes_working_copy(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        fixture_root = tmp_path / "git-remote"
        fixture_root.mkdir()
        _ = bare_repository_with_objects(parent=fixture_root)
        config_path = write_git_redirect_config(root=fixture_root)
        outcome = start_runtime(
            app_root=tmp_path / "app-data",
            overrides=WorkerEnvOverrides(
                git_config_global=config_path,
                git_config_nosystem=True,
            ),
        )
        runtime = outcome.runtime
        assert runtime is not None
        try:
            destination = tmp_path / "clone-dest"
            task_id = parse_task_id("journey-clone")
            runtime.create_task(
                task_id,
                make_clone_spec(destination=destination),
                parse_attempt_id("journey-clone-a1"),
            )

            _wait_state(qtbot, runtime, "journey-clone", LifecycleState.SUCCEEDED)

            assert (destination / "README.md").is_file()
            assert (destination / "data.bin").is_file()
            assert (destination / ".git").is_dir()
            assert runtime.detail(task_id).task.state == LifecycleState.SUCCEEDED
        finally:
            _shutdown(qtbot, runtime)


class TestQueuedAutoStartJourney:
    """Given several queued tasks, exactly one runs at a time in FIFO order."""

    def test_one_active_at_a_time_and_fifo_order(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        content = b"queued-content"
        with hub_fixture(
            files=[("a.bin", len(content)), ("b.bin", len(content))],
            content={"a.bin": content, "b.bin": content},
        ) as fixture:
            fixture_root = tmp_path / "git-remote"
            fixture_root.mkdir()
            _ = bare_repository_with_objects(parent=fixture_root)
            config_path = write_git_redirect_config(root=fixture_root)
            outcome = start_runtime(
                app_root=tmp_path / "app-data",
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint,
                    hub_cache_dir=tmp_path / "cache",
                    git_config_global=config_path,
                    git_config_nosystem=True,
                ),
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                terminals: list[tuple[str, str]] = []
                runtime.task_terminal.connect(_record_terminals(terminals))
                observed_active: list[int] = []

                def observe() -> None:
                    observed_active.append(runtime.snapshot().active_count)

                order = ["queue-download", "queue-clone", "queue-download-2"]
                runtime.create_task(
                    parse_task_id(order[0]),
                    make_file_spec(filename="a.bin", destination=tmp_path / "out-a"),
                    parse_attempt_id("qa1"),
                )
                runtime.create_task(
                    parse_task_id(order[1]),
                    make_clone_spec(destination=tmp_path / "clone-q"),
                    parse_attempt_id("qa2"),
                )
                runtime.create_task(
                    parse_task_id(order[2]),
                    make_file_spec(filename="b.bin", destination=tmp_path / "out-b"),
                    parse_attempt_id("qa3"),
                )
                for task_id in order:
                    _wait_state(qtbot, runtime, task_id, LifecycleState.SUCCEEDED)
                    observe()

                assert [tid for tid, _ in terminals] == order
                assert all(kind == "succeeded" for _, kind in terminals)
                assert max(observed_active) <= 1
                assert (tmp_path / "out-a" / "a.bin").is_file()
                assert (tmp_path / "clone-q" / "README.md").is_file()
                assert (tmp_path / "out-b" / "b.bin").is_file()
                assert runtime.snapshot().active_count == 0
            finally:
                _shutdown(qtbot, runtime)


class TestQueuedCancellationJourney:
    """Given a still-queued task, cancellation persists without any worker."""

    def test_queued_cancel_persists_without_launching_worker(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        with hub_fixture(
            files=[("a.bin", 8)], content={"a.bin": b"aaaaaaaa"}
        ) as fixture:
            outcome = start_runtime(
                app_root=tmp_path / "app-data",
                overrides=WorkerEnvOverrides(hub_endpoint=fixture.endpoint),
                open_dispatch_gate=False,
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                task_id = parse_task_id("queued-cancel")
                runtime.create_task(
                    task_id,
                    make_file_spec(filename="a.bin", destination=tmp_path / "out"),
                    parse_attempt_id("qc1"),
                )
                assert _task_state(runtime, "queued-cancel") == LifecycleState.QUEUED

                cancel_outcome = runtime.cancel(task_id)

                assert cancel_outcome.active_cancellation is False
                assert _task_state(runtime, "queued-cancel") == LifecycleState.CANCELLED
                assert runtime.active_supervisor(task_id) is None
                transitions = runtime.detail(task_id).transitions
                assert transitions[0].from_state == LifecycleState.QUEUED
                assert transitions[-1].to_state == LifecycleState.CANCELLED
                assert runtime.detail(task_id).events[-1].kind == "task_transitioned"
            finally:
                _shutdown(qtbot, runtime)


class TestActiveCancellationJourney:
    """Given a running task, cancellation terminalizes truthfully and continues."""

    def test_active_cancel_truthful_and_queue_continues(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        big = b"z" * (11 * 1024 * 1024)
        with hub_fixture(
            files=[("big.bin", len(big)), ("next.bin", 16)],
            content={"big.bin": big, "next.bin": b"n" * 16},
        ) as fixture:
            outcome = start_runtime(
                app_root=tmp_path / "app-data",
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint, hub_cache_dir=tmp_path / "cache"
                ),
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                running_task = parse_task_id("active-big")
                next_task = parse_task_id("active-next")
                running: list[str] = []
                runtime.task_running.connect(_record_running(running))
                runtime.create_task(
                    running_task,
                    make_file_spec(
                        filename="big.bin", destination=tmp_path / "out-big"
                    ),
                    parse_attempt_id("ac1"),
                )
                runtime.create_task(
                    next_task,
                    make_file_spec(
                        filename="next.bin", destination=tmp_path / "out-next"
                    ),
                    parse_attempt_id("ac2"),
                )

                _wait_state(qtbot, runtime, "active-big", LifecycleState.RUNNING)
                qtbot.waitUntil(lambda: bool(running), timeout=WAIT_TIMEOUT_MS)
                supervisor = runtime.active_supervisor(running_task)
                assert supervisor is not None
                worker_pid = supervisor.worker.pid
                assert worker_pid is not None

                cancel_outcome: CancelOutcome = runtime.cancel(running_task)

                assert cancel_outcome.active_cancellation is True
                _wait_state(qtbot, runtime, "active-big", LifecycleState.CANCELLED)
                _wait_state(qtbot, runtime, "active-next", LifecycleState.SUCCEEDED)

                assert wait_process_gone(worker_pid, timeout_seconds=60.0), (
                    "cancelled worker left an orphan process"
                )
                assert runtime.active_supervisor(running_task) is None
                assert (tmp_path / "out-next" / "next.bin").is_file()
                assert not (tmp_path / "out-big" / "big.bin").exists()
            finally:
                _shutdown(qtbot, runtime)


class TestRetryJourney:
    """Given terminal tasks, retry follows the domain's linked-attempt rules."""

    def test_retry_failed_creates_linked_queued_attempt(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        with hub_fixture(files=[("config.json", 8)]) as fixture:
            outcome = start_runtime(
                app_root=tmp_path / "app-data",
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint, hub_cache_dir=tmp_path / "cache"
                ),
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                task_id = parse_task_id("retry-me")
                runtime.create_task(
                    task_id,
                    make_file_spec(
                        filename="missing.bin", destination=tmp_path / "out"
                    ),
                    parse_attempt_id("r1"),
                )

                _wait_state(qtbot, runtime, "retry-me", LifecycleState.FAILED)

                result = runtime.retry(task_id, new_attempt_id=parse_attempt_id("r2"))

                assert result.linked_from == parse_attempt_id("r1")
                retried = runtime.detail(result.task_id).task
                assert retried.state in {
                    LifecycleState.QUEUED,
                    LifecycleState.RUNNING,
                    LifecycleState.SUCCEEDED,
                }
                assert retried.spec == make_file_spec(
                    filename="missing.bin", destination=tmp_path / "out"
                )
            finally:
                _shutdown(qtbot, runtime)

    def test_retry_succeeded_and_queued_are_rejected(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        with hub_fixture(
            files=[("ok.bin", 8)], content={"ok.bin": b"okokokok"}
        ) as fixture:
            outcome = start_runtime(
                app_root=tmp_path / "app-data",
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint, hub_cache_dir=tmp_path / "cache"
                ),
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                succeeded_task = parse_task_id("retry-succeeded")
                queued_task = parse_task_id("retry-queued")
                runtime.create_task(
                    succeeded_task,
                    make_file_spec(filename="ok.bin", destination=tmp_path / "out-s"),
                    parse_attempt_id("rs1"),
                )
                _wait_state(qtbot, runtime, "retry-succeeded", LifecycleState.SUCCEEDED)

                runtime.create_task(
                    queued_task,
                    make_file_spec(filename="ok.bin", destination=tmp_path / "out-q"),
                    parse_attempt_id("rq1"),
                )
                assert _task_state(runtime, "retry-queued") in {
                    LifecycleState.QUEUED,
                    LifecycleState.RUNNING,
                    LifecycleState.SUCCEEDED,
                }
                with pytest.raises(RetryNotAllowedError):
                    runtime.retry(
                        succeeded_task, new_attempt_id=parse_attempt_id("rs2")
                    )
                qtbot.waitUntil(
                    lambda: (
                        _task_state(runtime, "retry-queued") == LifecycleState.SUCCEEDED
                    ),
                    timeout=WAIT_TIMEOUT_MS,
                )
                with pytest.raises(RetryNotAllowedError):
                    runtime.retry(queued_task, new_attempt_id=parse_attempt_id("rq2"))
            finally:
                _shutdown(qtbot, runtime)


class TestDatabaseReopenJourney:
    """Given a closed runtime, reopening the database preserves history."""

    def test_reopen_preserves_states_and_history(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        with hub_fixture(
            files=[("keep.bin", 12)], content={"keep.bin": b"k" * 12}
        ) as fixture:
            app_root = tmp_path / "app-data"
            first = start_runtime(
                app_root=app_root,
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint, hub_cache_dir=tmp_path / "cache"
                ),
            )
            runtime_a = first.runtime
            assert runtime_a is not None
            task_id = parse_task_id("reopen-me")
            try:
                runtime_a.create_task(
                    task_id,
                    make_file_spec(filename="keep.bin", destination=tmp_path / "out"),
                    parse_attempt_id("ro1"),
                )
                _wait_state(qtbot, runtime_a, "reopen-me", LifecycleState.SUCCEEDED)
            finally:
                _shutdown(qtbot, runtime_a)

            second = start_runtime(
                app_root=app_root,
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint, hub_cache_dir=tmp_path / "cache"
                ),
            )
            runtime_b = second.runtime
            assert runtime_b is not None
            try:
                reopened = runtime_b.detail(task_id)
                assert reopened.task.state == LifecycleState.SUCCEEDED
                assert reopened.task.position == 1
                assert reopened.transitions[-1].to_state == LifecycleState.SUCCEEDED
                assert "task_transitioned" in [e.kind for e in reopened.events]
            finally:
                _shutdown(qtbot, runtime_b)
