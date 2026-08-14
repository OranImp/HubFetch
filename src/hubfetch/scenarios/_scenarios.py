"""Headless scenario implementations over the integrated transfer runtime.

# noqa: SIZE_OK - one module must enumerate the three scenario journeys
# (mixed-queue, cancel-crash-recover, secret-boundary) together with their
# shared Qt event-loop helpers; the canonical crash-app script lives in
# :mod:`hubfetch.scenarios._crash_app_script`.

Each scenario drives the real Todo 21 runtime against local deterministic
fixtures and returns a serializable evidence payload: ``mixed-queue`` proves
ordered one-at-a-time transfers with real artifacts, ``cancel-crash-recover``
proves Job kill-on-close leaves no orphan, startup recovery interrupts the
abandoned task, partials are preserved, and the queue continues;
``secret-boundary`` proves the vault-backed token never leaves the vault.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Final

from PySide6.QtCore import QCoreApplication
from tests.hub.fixtures import hub_fixture

from hubfetch.application.bootstrap import (
    BootstrapOptions,
    StartupOutcome,
    WorkerEnvOverrides,
    bootstrap_runtime,
)
from hubfetch.credentials.port import (
    CredentialBackendError,
    CredentialNotFoundError,
)
from hubfetch.credentials.windows_keyring import WindowsCredentialManagerStore
from hubfetch.domain.ids import parse_attempt_id, parse_task_id
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.domain.task_spec import AuthSource
from hubfetch.runtime.process_environment import environment_mapping

from ._crash_app_script import CRASH_APP_SCRIPT
from ._fixtures import (
    SENTINEL,
    RunWorkspace,
    bare_repository_with_objects,
    kill_process_without_tree,
    make_clone_spec,
    make_file_spec,
    recursive_scan_for_secret,
    spawn_crash_app,
    wait_process_gone,
    write_git_redirect_config,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from hubfetch.application.runtime import Runtime

POLL_INTERVAL_SECONDS: Final = 0.02

_START_FAILED: Final = "scenario runtime failed to start: {reason}"
_WAIT_FAILED: Final = "timed out waiting for task {task_id} to reach {state}"


def _qt_app() -> QCoreApplication:
    """Return the shared Qt core application, creating one if needed."""
    app = QCoreApplication.instance()
    if app is not None:
        return app
    return QCoreApplication([])


def _require_runtime(outcome: StartupOutcome) -> Runtime:
    """Return the runtime or fail the scenario with the typed fatal reason."""
    if outcome.runtime is None or outcome.fatal is not None:
        reason = str(outcome.fatal) if outcome.fatal is not None else "unknown"
        message = _START_FAILED.format(reason=reason)
        raise AssertionError(message)
    return outcome.runtime


def _start_runtime(
    workspace: RunWorkspace, overrides: WorkerEnvOverrides
) -> StartupOutcome:
    """Bootstrap one runtime under the workspace's portable application root."""
    os.environ["HUBFETCH_APP_DATA_ROOT"] = str(workspace.app_root)
    _ensure_worker_python_path()
    interpreter = getattr(sys, "_base_executable", None) or sys.executable
    return bootstrap_runtime(
        options=BootstrapOptions(
            worker_command_prefix=(
                interpreter,
                "-u",
                "-m",
                "hubfetch.scenarios.worker",
                "--worker",
            ),
            worker_overrides=overrides,
        )
    )


def _ensure_worker_python_path() -> None:
    """Export ``sys.path`` so base-interpreter workers can import ``hubfetch``.

    The scenario workers run under the single-image base CPython executable for
    deterministic Job containment; it does not carry the virtualenv's
    site-packages, so the parent interpreter's ``sys.path`` (which includes the
    editable install) is exported as ``PYTHONPATH`` for those workers.
    """
    if not os.environ.get("PYTHONPATH"):
        os.environ["PYTHONPATH"] = os.pathsep.join(entry for entry in sys.path if entry)


def _wait_state(
    app: QCoreApplication,
    runtime: Runtime,
    task_id: str,
    state: LifecycleState,
    *,
    timeout_seconds: float = 120.0,
) -> None:
    """Drive the event loop until a task reaches the given state."""
    deadline = time.monotonic() + timeout_seconds
    while runtime.detail(parse_task_id(task_id)).task.state != state:
        app.processEvents()
        if time.monotonic() > deadline:
            message = _WAIT_FAILED.format(task_id=task_id, state=state.value)
            raise AssertionError(message)
        time.sleep(POLL_INTERVAL_SECONDS)


def _shutdown_runtime(app: QCoreApplication, runtime: Runtime) -> None:
    """Begin the bounded orderly shutdown and wait for its clean finish."""
    shutdown = runtime.shutdown()
    deadline = time.monotonic() + 60.0
    while not shutdown.finished_cleanly:
        app.processEvents()
        if time.monotonic() > deadline:
            break
        time.sleep(POLL_INTERVAL_SECONDS)
    runtime.close()


def _terminal_recorder(
    terminals: list[tuple[str, str]],
) -> Callable[[str, str], None]:
    """Return a typed terminal-event recorder bound to one list."""

    def record(task_id: str, kind: str) -> None:
        terminals.append((task_id, kind))

    return record


def run_mixed_queue() -> dict[str, object]:
    """Enqueue download/clone/download and record ordered terminal results."""
    workspace = RunWorkspace()
    try:
        content = b"scenario-mixed-queue-content"
        with hub_fixture(
            files=[("config.json", len(content)), ("model.bin", 128)],
            content={"config.json": content, "model.bin": b"m" * 128},
        ) as fixture:
            git_root = bare_repository_with_objects(parent=workspace.git_root)
            config_path = write_git_redirect_config(root=git_root)
            app = _qt_app()
            outcome = _start_runtime(
                workspace,
                WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint,
                    hub_cache_dir=workspace.cache_dir,
                    git_config_global=config_path,
                    git_config_nosystem=True,
                ),
            )
            runtime = _require_runtime(outcome)
            terminals: list[tuple[str, str]] = []
            observed_active: list[int] = []
            order = ["t-0", "t-1", "t-2"]
            _ = runtime.task_terminal.connect(_terminal_recorder(terminals))
            _ = runtime.create_task(
                parse_task_id("t-0"),
                make_file_spec(
                    filename="config.json", destination=workspace.out_dir / "a"
                ),
                parse_attempt_id("a0"),
            )
            _ = runtime.create_task(
                parse_task_id("t-1"),
                make_clone_spec(destination=workspace.out_dir / "clone"),
                parse_attempt_id("a1"),
            )
            _ = runtime.create_task(
                parse_task_id("t-2"),
                make_file_spec(
                    filename="model.bin", destination=workspace.out_dir / "b"
                ),
                parse_attempt_id("a2"),
            )
            for task_id in order:
                _wait_state(app, runtime, task_id, LifecycleState.SUCCEEDED)
                observed_active.append(runtime.snapshot().active_count)
            artifacts = {
                "t-0": str(workspace.out_dir / "a" / "config.json"),
                "t-1": str(workspace.out_dir / "clone" / "README.md"),
                "t-2": str(workspace.out_dir / "b" / "model.bin"),
            }
            _shutdown_runtime(app, runtime)
            return {
                "scenario": "mixed-queue",
                "terminal_order": [task_id for task_id, _ in terminals],
                "terminal_kinds": [kind for _, kind in terminals],
                "max_observed_active": max(observed_active),
                "artifacts_exist": {
                    task_id: Path(path).is_file() for task_id, path in artifacts.items()
                },
                "artifacts": artifacts,
            }
    finally:
        workspace.close()


def run_cancel_crash_recover() -> dict[str, object]:
    """Kill a running runtime, recover the abandoned task, and continue."""
    workspace = RunWorkspace()
    app_script = workspace.fixtures_dir / "crash_app.py"
    _ = app_script.write_text(CRASH_APP_SCRIPT, encoding="utf-8")
    _ensure_worker_python_path()
    try:
        big = b"c" * (11 * 1024 * 1024)
        with hub_fixture(
            files=[("big.bin", len(big))],
            content={"big.bin": big},
            download_error={"big.bin": "truncate_once"},
        ) as fixture:
            process, worker_pid, _marker, _pid_file = spawn_crash_app(
                app_script=app_script,
                app_root=workspace.app_root,
                endpoint=fixture.endpoint,
                cache_dir=workspace.cache_dir,
                work_dir=workspace.fixtures_dir,
            )
            try:
                kill_process_without_tree(process.pid)
                _ = process.wait(timeout=30)
                terminated = wait_process_gone(worker_pid, timeout_seconds=60.0)

                app = _qt_app()
                outcome = _start_runtime(
                    workspace,
                    WorkerEnvOverrides(
                        hub_endpoint=fixture.endpoint,
                        hub_cache_dir=workspace.cache_dir,
                    ),
                )
                runtime = _require_runtime(outcome)
                recovered = [str(task_id) for task_id in outcome.recovered]
                abandoned = runtime.detail(parse_task_id("crash-download")).task
                partials = [
                    str(path)
                    for path in workspace.cache_dir.rglob("*")
                    if path.is_file()
                ]
                _ = runtime.create_task(
                    parse_task_id("continue-crash"),
                    make_file_spec(
                        filename="big.bin", destination=workspace.out_dir / "c"
                    ),
                    parse_attempt_id("c1"),
                )
                _wait_state(app, runtime, "continue-crash", LifecycleState.SUCCEEDED)
                hits = recursive_scan_for_secret(workspace.app_root, SENTINEL)
                _shutdown_runtime(app, runtime)
                return {
                    "scenario": "cancel-crash-recover",
                    "worker_pid": worker_pid,
                    "worker_pid_terminated_after_crash": terminated,
                    "recovered_task_ids": recovered,
                    "recovered_state": abandoned.state.value,
                    "partial_file_count": len(partials),
                    "partials_preserved": len(partials) > 0,
                    "queued_continuation_state": "succeeded",
                    "secret_scan_hits": [str(path) for path in hits],
                }
            finally:
                if process.poll() is None:
                    kill_process_without_tree(process.pid)
    finally:
        workspace.close()


def run_secret_boundary() -> dict[str, object]:
    """Prove a vault-backed token never leaves the vault or app boundaries."""
    workspace = RunWorkspace()
    store = WindowsCredentialManagerStore()
    alias = store.create(token=SENTINEL)
    result: dict[str, object] = {}
    try:
        content = b"scenario-secret-content"
        with hub_fixture(
            files=[("config.json", len(content))],
            content={"config.json": content},
            expect_token=SENTINEL,
        ) as fixture:
            app = _qt_app()
            outcome = _start_runtime(
                workspace,
                WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint,
                    hub_cache_dir=workspace.cache_dir,
                    credential_alias=alias,
                ),
            )
            runtime = _require_runtime(outcome)
            task_id = parse_task_id("secret")
            _ = runtime.create_task(
                task_id,
                make_file_spec(
                    filename="config.json",
                    destination=workspace.out_dir / "s",
                    auth=AuthSource.MANUAL_TOKEN,
                ),
                parse_attempt_id("s1"),
            )
            _wait_state(app, runtime, task_id, LifecycleState.SUCCEEDED)
            worker_env = environment_mapping(runtime.worker_environment(task_id))
            worker_argv = "\n".join(runtime.worker_argv(task_id))
            env_text = "\n".join(
                f"{name}={value}" for name, value in sorted(worker_env.items())
            )
            hits = recursive_scan_for_secret(workspace.app_root, SENTINEL)
            _shutdown_runtime(app, runtime)
            result = {
                "scenario": "secret-boundary",
                "backend_module": store.backend_identity.module,
                "backend_class": store.backend_identity.class_name,
                "credential_alias": alias,
                "task_state": "succeeded",
                "scans": {
                    "database_and_app_root": len(hits),
                    "worker_argv": SENTINEL in worker_argv,
                    "worker_environment": SENTINEL in env_text,
                },
                "sentinel_absent_everywhere": (
                    not hits
                    and SENTINEL not in worker_argv
                    and SENTINEL not in env_text
                ),
                "vault_cleanup": False,
            }
    finally:
        try:
            store.delete(alias)
            result["vault_cleanup"] = True
        except (CredentialNotFoundError, CredentialBackendError):
            result["vault_cleanup"] = False
        workspace.close()
    return result
