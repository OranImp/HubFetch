"""Canonical crashable application script for the crash-recovery journey.

The script bootstraps a real runtime under a portable app root, creates one
large download task, pumps the Qt event loop until a byte-progress event flows
(so the kill interrupts a live transfer), writes the worker PID and a marker,
then exits abruptly without any orderly shutdown. Exiting without
``Runtime.shutdown`` simulates a crashed GUI: the Job Object's kill-on-close
terminates the worker tree and the persisted ``running`` row is left for the
next startup's ``recover_interrupted``.
"""

CRASH_APP_SCRIPT: str = """\
import os
import sys
import time
from pathlib import Path

from PySide6.QtCore import QCoreApplication

from hubfetch.application.bootstrap import (
    BootstrapOptions,
    WorkerEnvOverrides,
    bootstrap_runtime,
)
from hubfetch.domain.ids import parse_attempt_id, parse_repository_id, parse_task_id
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import (
    AuthSource,
    LocalDirectoryDestination,
    OverwriteExisting,
    ProxyMode,
    SingleFileDownloadSpec,
)


def make_spec(destination):
    return SingleFileDownloadSpec(
        kind="single_file",
        repository=RepositoryRef(
            repo_id=parse_repository_id("org/repo"), kind=ModelRepository()
        ),
        filename="big.bin",
        destination=LocalDirectoryDestination(path=destination),
        conflict_policy=OverwriteExisting(),
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def main() -> int:
    app_root, fixture_endpoint, cache_dir, marker, pid_file = sys.argv[1:6]
    os.environ["HUBFETCH_APP_DATA_ROOT"] = app_root
    interpreter = getattr(sys, "_base_executable", None) or sys.executable
    outcome = bootstrap_runtime(
        options=BootstrapOptions(
            worker_command_prefix=(
                interpreter,
                "-u",
                "-m",
                "hubfetch.scenarios.worker",
                "--worker",
            ),
            worker_overrides=WorkerEnvOverrides(
                hub_endpoint=fixture_endpoint,
                hub_cache_dir=Path(cache_dir),
            ),
        ),
    )
    runtime = outcome.runtime
    if runtime is None:
        print("NO_RUNTIME", flush=True)
        return 3
    app = QCoreApplication.instance() or QCoreApplication([])
    progress: list[str] = []
    runtime.progress_received.connect(progress.append)
    task_id = parse_task_id("crash-download")
    runtime.create_task(
        task_id,
        make_spec(Path(cache_dir) / "out"),
        parse_attempt_id("crash-a1"),
    )
    deadline = time.monotonic() + 90.0
    while True:
        app.processEvents()
        state = runtime.detail(task_id).task.state
        supervisor = runtime.active_supervisor(task_id)
        pid = supervisor.worker.pid if supervisor is not None else None
        # A byte-progress event means the transfer is streaming, so the kill
        # interrupts a live download and preserved partial data is
        # deterministic (the fixture truncates once to force a resume window).
        if (
            state == LifecycleState.RUNNING
            and "progress" in progress
            and pid is not None
        ):
            Path(pid_file).write_text(str(pid), encoding="utf-8")
            Path(marker).write_text("running", encoding="utf-8")
            print("RUNNING", flush=True)
            return 0
        if time.monotonic() > deadline:
            print("TIMEOUT", flush=True)
            return 4
        time.sleep(0.02)


if __name__ == "__main__":
    sys.exit(main())
"""
