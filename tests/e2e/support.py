"""Shared deterministic runtime harness for the end-to-end journey tests.

Real subprocesses, real temporary SQLite/files, and the real supervisor are
used throughout; nothing here is mocked. The harness composes the Todo 21
runtime through the public bootstrap boundary, builds per-run fixtures
(deterministic Hub-compatible HTTP server, local bare Git repository with a
URL redirect), and offers bounded event-driven waits plus recursive sentinel
scans for the secret-boundary suite.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from typing import TYPE_CHECKING, Final

from hubfetch.application.bootstrap import (
    BootstrapOptions,
    StartupOutcome,
    WorkerEnvOverrides,
    bootstrap_runtime,
)
from hubfetch.domain.ids import parse_repository_id
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import (
    AuthSource,
    GitCloneSpec,
    LocalDirectoryDestination,
    OverwriteExisting,
    ProxyMode,
    SingleFileDownloadSpec,
)
from hubfetch.platform.windows.job_object import OpenProcessError, open_process
from hubfetch.runtime.process_environment import environment_mapping
from tests.fixtures.process_tree import fixture_interpreter

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from PySide6.QtCore import QProcessEnvironment

HF_TEST_SECRET: Final = "hf_test_secret_123"  # noqa: S105
"""Sentinel token whose bytes must never cross any HubFetch boundary."""

DEV_WORKER_COMMAND: Final = (
    fixture_interpreter(),
    "-u",
    "-m",
    "hubfetch.scenarios.worker",
    "--worker",
)
"""Worker argv prefix using the single-image base interpreter for Job jobs."""

POLL_INTERVAL_SECONDS: Final = 0.02


def wait_until(
    predicate: Callable[[], bool],
    *,
    timeout_seconds: float = 90.0,
    what: str = "condition",
) -> None:
    """Observe ``predicate`` become true within a hard deadline.

    Bounded polling with a deadline is the documented synchronization pattern
    of the process-tree fixtures; a fixed sleep is never used as the wait.
    """
    deadline = time.monotonic() + timeout_seconds
    while not predicate():
        if time.monotonic() > deadline:
            message = f"timed out waiting for {what}"
            raise AssertionError(message)
        time.sleep(POLL_INTERVAL_SECONDS)


def start_runtime(
    *,
    app_root: Path,
    overrides: WorkerEnvOverrides | None = None,
    open_dispatch_gate: bool = True,
) -> StartupOutcome:
    """Bootstrap one runtime under the given portable application root."""
    os.environ["HUBFETCH_APP_DATA_ROOT"] = str(app_root)
    _ensure_worker_python_path()
    return bootstrap_runtime(
        options=BootstrapOptions(
            worker_command_prefix=DEV_WORKER_COMMAND,
            worker_overrides=overrides or WorkerEnvOverrides(),
            open_dispatch_gate=open_dispatch_gate,
        )
    )


def _ensure_worker_python_path() -> None:
    """Make ``hubfetch`` importable to the single-image base-interpreter workers.

    The worker runs under the base CPython executable (one process image so Job
    containment is deterministic), which does not carry the virtualenv's
    site-packages by itself. Exporting the current interpreter's ``sys.path``
    as ``PYTHONPATH`` lets those workers import ``hubfetch`` from the editable
    install without any launcher-process indirection.
    """
    if not os.environ.get("PYTHONPATH"):
        os.environ["PYTHONPATH"] = os.pathsep.join(entry for entry in sys.path if entry)


def make_file_spec(
    *,
    filename: str,
    destination: Path,
    auth: AuthSource = AuthSource.ANONYMOUS,
) -> SingleFileDownloadSpec:
    """Build one single-file download spec into a local directory."""
    return SingleFileDownloadSpec(
        kind="single_file",
        repository=RepositoryRef(
            repo_id=parse_repository_id("org/repo"), kind=ModelRepository()
        ),
        filename=filename,
        destination=LocalDirectoryDestination(path=destination),
        conflict_policy=OverwriteExisting(),
        auth_source=auth,
        proxy_mode=ProxyMode.SYSTEM,
    )


def make_repository() -> RepositoryRef:
    """Return the deterministic repository reference shared by every journey."""
    return RepositoryRef(
        repo_id=parse_repository_id("org/repo"), kind=ModelRepository()
    )


def make_clone_spec(*, destination: Path) -> GitCloneSpec:
    """Build one Git clone spec targeting an empty destination directory."""
    return GitCloneSpec(
        kind="git_clone",
        repository=make_repository(),
        destination=destination,
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


_GIT_REQUIRED: Final = "system Git is required for the clone journey"


def bare_repository_with_objects(*, parent: Path) -> Path:
    """Create ``parent/org/repo`` as a local bare repository with objects.

    Returns ``parent`` so the URL redirect base matches the rewritten
    ``https://huggingface.co/org/repo`` prefix.
    """
    git = shutil.which("git")
    if git is None:
        raise AssertionError(_GIT_REQUIRED)
    work = parent / "work"
    work.mkdir()
    (work / "README.md").write_text("# fixture repository\n", encoding="utf-8")
    (work / "data.bin").write_bytes(b"\x00" * 64)
    subprocess.run(  # noqa: S603
        [git, "init", "--initial-branch=main", str(work)],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(  # noqa: S603
        [git, "-C", str(work), "add", "."], check=True, capture_output=True, text=True
    )
    subprocess.run(  # noqa: S603
        [
            git,
            "-C",
            str(work),
            "-c",
            "user.name=HubFetch Test",
            "-c",
            "user.email=test@hubfetch.invalid",
            "commit",
            "-m",
            "initial",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    org = parent / "org"
    org.mkdir()
    subprocess.run(  # noqa: S603
        [git, "clone", "--bare", str(work), str(org / "repo")],
        check=True,
        capture_output=True,
        text=True,
    )
    return parent


def write_git_redirect_config(*, root: Path) -> Path:
    """Write a gitconfig rewriting ``https://huggingface.co/`` to a local path.

    The rewritten URL ``https://huggingface.co/org/repo`` becomes
    ``file:///<root>/org/repo``, which is the local bare repository created by
    :func:`bare_repository_with_objects`.
    """
    git = shutil.which("git")
    if git is None:
        raise AssertionError(_GIT_REQUIRED)
    config_path = root / "gitconfig"
    base = "file:///" + str(root).replace("\\", "/")
    subprocess.run(  # noqa: S603
        [
            git,
            "config",
            "--file",
            str(config_path),
            f"url.{base}/.insteadOf",
            "https://huggingface.co/",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return config_path


def worker_environment_scan(environment: QProcessEnvironment) -> str:
    """Return one joined string of the worker environment for sentinel scans."""
    values = environment_mapping(environment)
    return "\n".join(f"{name}={value}" for name, value in sorted(values.items()))


def recursive_scan_for_secret(root: Path, secret: str) -> tuple[Path, ...]:
    """Return every regular file under ``root`` whose bytes contain ``secret``."""
    hits: list[Path] = []
    target = secret.encode("utf-8")
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if target in data:
            hits.append(path)
    return tuple(hits)


def kill_process_without_tree(pid: int) -> None:
    """Force-terminate one process without touching its descendants.

    The Job Object's kill-on-close must be what terminates the worker tree, so
    the process tree is deliberately left alone here.
    """
    taskkill = shutil.which("taskkill") or "taskkill"
    subprocess.run(  # noqa: S603
        [taskkill, "/F", "/PID", str(pid)],
        check=False,
        capture_output=True,
        timeout=30,
    )


def wait_process_gone(pid: int, *, timeout_seconds: float = 30.0) -> bool:
    """Return whether the given PID stopped opening a process handle in time."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            with open_process(pid):
                pass
        except OpenProcessError:
            return True
        time.sleep(POLL_INTERVAL_SECONDS)
    return False
