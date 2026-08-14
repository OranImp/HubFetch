"""End-to-end interrupted-startup recovery journey tests.

# noqa: SIZE_OK - one module must enumerate the full recovery matrix (startup
# interruption, idempotence, and the crash-kill-recover journey) as real
# subprocess runs against a canonical crashable application script.

A task abandoned in ``running`` (its runtime died without a terminal commit)
must be recovered as ``interrupted`` on the next startup before any dispatch.
A runtime killed abruptly must leave no orphan worker behind (the Job
Object's kill-on-close is the only termination), must preserve the partial
transfer artifacts, and the queue must continue dispatching after recovery.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import time
from typing import TYPE_CHECKING, Final

import pytest

from hubfetch.application.bootstrap import WorkerEnvOverrides
from hubfetch.config.paths import resolve_app_paths
from hubfetch.domain.ids import parse_attempt_id, parse_task_id
from hubfetch.domain.lifecycle import LifecycleEvent, LifecycleState
from hubfetch.persistence.connection import open_connection
from hubfetch.persistence.migrations import migrate
from hubfetch.persistence.task_repository import TaskRepository
from hubfetch.scenarios._crash_app_script import CRASH_APP_SCRIPT
from tests.e2e.support import (
    make_file_spec,
    recursive_scan_for_secret,
    start_runtime,
    wait_process_gone,
)
from tests.helpers.clock import ControllableClock
from tests.hub.fixtures import hub_fixture

if TYPE_CHECKING:
    import sqlite3
    from pathlib import Path

    from pytestqt.qtbot import QtBot

    from hubfetch.application.runtime import Runtime

pytestmark = pytest.mark.windows
if platform.system() != "Windows":
    pytest.skip(allow_module_level=True)

WAIT_TIMEOUT_MS: Final = 60_000
SECRET: Final = "hf_test_secret_123"  # noqa: S105
_APP_NEVER_RUNNING: Final = "app never reached the running state"


def _persist_running_task(*, app_root: Path) -> None:
    """Persist one task in the ``running`` state behind the app root.

    The running row simulates a runtime that died without a terminal commit;
    only the next startup's ``recover_interrupted`` may convert it.
    """
    os.environ["HUBFETCH_APP_DATA_ROOT"] = str(app_root)
    database = resolve_app_paths().database_path
    connection: sqlite3.Connection = open_connection(database)
    try:
        migrate(connection)
        repository = TaskRepository(connection, clock=ControllableClock())
        repository.create(
            parse_task_id("abandoned"),
            make_file_spec(filename="ok.bin", destination=app_root / "out"),
            parse_attempt_id("ab1"),
        )
        repository.transition(
            parse_task_id("abandoned"),
            expected_state=LifecycleState.QUEUED,
            event=LifecycleEvent.START,
        )
    finally:
        connection.close()


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


def _spawn_crash_app(
    *,
    app_root: Path,
    endpoint: str,
    cache_dir: Path,
    tmp_path: Path,
) -> tuple[subprocess.Popen[str], int]:
    """Spawn the crashable app and return its process and the worker PID."""
    script = tmp_path / "crash_app.py"
    _ = script.write_text(CRASH_APP_SCRIPT, encoding="utf-8")
    marker = tmp_path / "marker"
    pid_file = tmp_path / "worker-pid"
    environment = dict(os.environ)
    if not environment.get("PYTHONPATH"):
        environment["PYTHONPATH"] = os.pathsep.join(
            entry for entry in sys.path if entry
        )
    process = subprocess.Popen(  # noqa: S603
        [
            sys.executable,
            "-u",
            str(script),
            str(app_root),
            endpoint,
            str(cache_dir),
            str(marker),
            str(pid_file),
        ],
        cwd=str(tmp_path),
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    deadline = time.monotonic() + 90.0
    while not marker.exists():
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout is not None else ""
            message = f"app exited before running: {output}"
            raise AssertionError(message)
        if time.monotonic() > deadline:
            process.kill()
            raise AssertionError(_APP_NEVER_RUNNING)
        time.sleep(0.05)
    worker_pid = int(pid_file.read_text(encoding="utf-8").strip())
    return process, worker_pid


class TestInterruptedStartupRecovery:
    """Given an abandoned active task, startup interrupts it before dispatch."""

    def test_recovery_converts_running_to_interrupted_then_dispatch_resumes(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        app_root = tmp_path / "app-data"
        _persist_running_task(app_root=app_root)
        with hub_fixture(
            files=[("ok.bin", 8)], content={"ok.bin": b"okokokok"}
        ) as fixture:
            outcome = start_runtime(
                app_root=app_root,
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint, hub_cache_dir=tmp_path / "cache"
                ),
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                assert "abandoned" in outcome.recovered
                assert _task_state(runtime, "abandoned") == LifecycleState.INTERRUPTED
                recovered_events = [
                    event
                    for event in runtime.detail(parse_task_id("abandoned")).events
                    if event.kind == "task_recovered"
                ]
                assert len(recovered_events) == 1

                runtime.create_task(
                    parse_task_id("after-recovery"),
                    make_file_spec(filename="ok.bin", destination=tmp_path / "out-b"),
                    parse_attempt_id("ab2"),
                )
                _wait_state(qtbot, runtime, "after-recovery", LifecycleState.SUCCEEDED)
            finally:
                _shutdown(qtbot, runtime)

    def test_recovery_is_idempotent(self, qtbot: QtBot, tmp_path: Path) -> None:
        app_root = tmp_path / "app-data"
        _persist_running_task(app_root=app_root)
        with hub_fixture(files=[("ok.bin", 8)]) as fixture:
            first = start_runtime(
                app_root=app_root,
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint, hub_cache_dir=tmp_path / "cache"
                ),
            )
            runtime_a = first.runtime
            assert runtime_a is not None
            assert "abandoned" in first.recovered
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
                assert "abandoned" not in second.recovered
                assert _task_state(runtime_b, "abandoned") == LifecycleState.INTERRUPTED
                recovered_events = [
                    event
                    for event in runtime_b.detail(parse_task_id("abandoned")).events
                    if event.kind == "task_recovered"
                ]
                assert len(recovered_events) == 1
            finally:
                _shutdown(qtbot, runtime_b)


class TestCrashRecoveryJourney:
    """Given an abruptly killed runtime, the tree dies, recovery interrupts."""

    def test_crash_kills_tree_recovers_and_continues(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        big = b"c" * (11 * 1024 * 1024)
        with hub_fixture(
            files=[("big.bin", len(big))],
            content={"big.bin": big},
            download_error={"big.bin": "truncate_once"},
        ) as fixture:
            app_root = tmp_path / "app-data"
            cache_dir = tmp_path / "cache"
            app_process, worker_pid = _spawn_crash_app(
                app_root=app_root,
                endpoint=fixture.endpoint,
                cache_dir=cache_dir,
                tmp_path=tmp_path,
            )
            try:
                taskkill = shutil.which("taskkill") or "taskkill"
                subprocess.run(  # noqa: S603
                    [taskkill, "/F", "/PID", str(app_process.pid)],
                    check=False,
                    capture_output=True,
                    timeout=30,
                )
                _ = app_process.wait(timeout=30)
                if app_process.stdout is not None:
                    app_process.stdout.close()
                assert wait_process_gone(worker_pid, timeout_seconds=60.0), (
                    "worker survived the killed runtime"
                )

                recovered = start_runtime(
                    app_root=app_root,
                    overrides=WorkerEnvOverrides(
                        hub_endpoint=fixture.endpoint, hub_cache_dir=cache_dir
                    ),
                )
                runtime = recovered.runtime
                assert runtime is not None
                try:
                    assert "crash-download" in recovered.recovered
                    assert (
                        _task_state(runtime, "crash-download")
                        == LifecycleState.INTERRUPTED
                    )
                    partials = list(cache_dir.rglob("*"))
                    assert any(path.is_file() for path in partials), (
                        "interrupted transfer preserved no partial artifacts"
                    )
                    hits = recursive_scan_for_secret(app_root, SECRET)
                    assert hits == (), f"secret leaked into {hits}"

                    runtime.create_task(
                        parse_task_id("continue-after-crash"),
                        make_file_spec(
                            filename="big.bin", destination=tmp_path / "out-c"
                        ),
                        parse_attempt_id("crash2"),
                    )
                    _wait_state(
                        qtbot, runtime, "continue-after-crash", LifecycleState.SUCCEEDED
                    )
                finally:
                    _shutdown(qtbot, runtime)
            finally:
                if app_process.poll() is None:
                    taskkill = shutil.which("taskkill") or "taskkill"
                    subprocess.run(  # noqa: S603
                        [taskkill, "/F", "/PID", str(app_process.pid)],
                        check=False,
                        capture_output=True,
                        timeout=30,
                    )
