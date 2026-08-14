"""Deterministic fixture builders for the headless scenario runner.

# noqa: SIZE_OK - one module owns the whole deterministic fixture surface of
# the scenario runner (Hub-compatible git fixtures, workspace lifecycle,
# process spawn/kill, and sentinel scans) shared by all three scenarios.

The runner drives the real integrated runtime against local deterministic
fixtures: a Hub-compatible HTTP server, a local bare Git repository with a URL
redirect, and a crashable application subprocess. These helpers deliberately
stand alone from the test harness so ``python -m hubfetch.scenarios.main``
works from a clean shell.
"""

from __future__ import annotations

import shutil
import stat
import subprocess
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Final, final

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

if TYPE_CHECKING:
    from collections.abc import Callable

SENTINEL: Final = "hf_test_secret_123"
POLL_INTERVAL_SECONDS: Final = 0.02

_GIT_REQUIRED: Final = "system Git is required for the clone scenario"
_WAIT_TIMEOUT: Final = "timed out waiting for {what}"
_APP_EXITED: Final = "app exited before running: {output}"
_APP_NEVER_RUNNING: Final = "app never reached the running state"


def make_repository() -> RepositoryRef:
    """Return the deterministic repository reference used by the scenarios."""
    return RepositoryRef(
        repo_id=parse_repository_id("org/repo"), kind=ModelRepository()
    )


def make_file_spec(
    *,
    filename: str,
    destination: Path,
    auth: AuthSource = AuthSource.ANONYMOUS,
) -> SingleFileDownloadSpec:
    """Build one single-file download spec into a local directory."""
    return SingleFileDownloadSpec(
        kind="single_file",
        repository=make_repository(),
        filename=filename,
        destination=LocalDirectoryDestination(path=destination),
        conflict_policy=OverwriteExisting(),
        auth_source=auth,
        proxy_mode=ProxyMode.SYSTEM,
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


@final
class RunWorkspace:
    """Own one unique temporary workspace that is always cleaned up."""

    __slots__: Final = ("_root",)

    def __init__(self) -> None:
        """Create the workspace root and its named subdirectories."""
        self._root = Path(tempfile.mkdtemp(prefix="hubfetch-scenario-"))
        for name in ("app-data", "cache", "fixtures", "out", "git-remote"):
            (self._root / name).mkdir()

    @property
    def app_root(self) -> Path:
        """Return the portable application data root."""
        return self._root / "app-data"

    @property
    def cache_dir(self) -> Path:
        """Return the isolated Hub cache root."""
        return self._root / "cache"

    @property
    def fixtures_dir(self) -> Path:
        """Return the fixture root (hub/evidence staging)."""
        return self._root / "fixtures"

    @property
    def out_dir(self) -> Path:
        """Return the destination root for task artifacts."""
        return self._root / "out"

    @property
    def git_root(self) -> Path:
        """Return the local Git remote root."""
        return self._root / "git-remote"

    def close(self) -> None:
        """Remove the whole workspace, clearing read-only attributes first.

        Git bare repositories leave read-only object files; ``rmtree`` on
        Windows silently skips them, so read-only attributes are cleared before
        removal and a short bounded retry covers still-releasing handles.
        """
        _clear_readonly(self._root)
        deadline = time.monotonic() + 10.0
        while True:
            shutil.rmtree(self._root, ignore_errors=True)
            if not self._root.exists():
                return
            if time.monotonic() > deadline:
                return
            _clear_readonly(self._root)
            time.sleep(POLL_INTERVAL_SECONDS)


def _system_git() -> str:
    """Return the system Git executable or raise a typed fixture failure."""
    executable = shutil.which("git")
    if executable is None:
        raise AssertionError(_GIT_REQUIRED)
    return executable


def _clear_readonly(root: Path) -> None:
    """Clear the read-only attribute on every file under ``root``.

    Git bare repositories and working copies mark objects read-only; Windows
    refuses to delete them, so attributes are cleared before any removal.
    """
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            path.chmod(stat.S_IWRITE)
        except OSError:
            continue


def bare_repository_with_objects(*, parent: Path) -> Path:
    """Create ``parent/org/repo`` as a local bare repository with objects."""
    git = _system_git()
    work = parent / "work"
    work.mkdir()
    _ = (work / "README.md").write_text("# fixture repository\n", encoding="utf-8")
    _ = (work / "data.bin").write_bytes(b"\x00" * 64)
    _ = subprocess.run(  # noqa: S603
        [git, "init", "--initial-branch=main", str(work)],
        check=True,
        capture_output=True,
        text=True,
    )
    _ = subprocess.run(  # noqa: S603
        [git, "-C", str(work), "add", "."], check=True, capture_output=True, text=True
    )
    _ = subprocess.run(  # noqa: S603
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
    _ = subprocess.run(  # noqa: S603
        [git, "clone", "--bare", str(work), str(org / "repo")],
        check=True,
        capture_output=True,
        text=True,
    )
    return parent


def write_git_redirect_config(*, root: Path) -> Path:
    """Write a gitconfig rewriting ``https://huggingface.co/`` to a local path."""
    git = _system_git()
    config_path = root / "gitconfig"
    base = "file:///" + str(root).replace("\\", "/")
    _ = subprocess.run(  # noqa: S603
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


def wait_until(
    predicate: Callable[[], bool],
    *,
    timeout_seconds: float = 90.0,
    what: str = "condition",
) -> None:
    """Observe ``predicate`` become true within a hard deadline."""
    deadline = time.monotonic() + timeout_seconds
    while not predicate():
        if time.monotonic() > deadline:
            message = _WAIT_TIMEOUT.format(what=what)
            raise AssertionError(message)
        time.sleep(POLL_INTERVAL_SECONDS)


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
    """Force-terminate one process without touching its descendants."""
    taskkill = shutil.which("taskkill") or "taskkill"
    _ = subprocess.run(  # noqa: S603
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


def spawn_crash_app(
    *,
    app_script: Path,
    app_root: Path,
    endpoint: str,
    cache_dir: Path,
    work_dir: Path,
) -> tuple[subprocess.Popen[str], int, Path, Path]:
    """Spawn the crashable app and return its process, worker PID, and markers."""
    marker = work_dir / "marker"
    pid_file = work_dir / "worker-pid"
    process = subprocess.Popen(  # noqa: S603
        [
            shutil.which("python") or "python",
            "-u",
            str(app_script),
            str(app_root),
            endpoint,
            str(cache_dir),
            str(marker),
            str(pid_file),
        ],
        cwd=str(work_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    deadline = time.monotonic() + 90.0
    while not marker.exists():
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout is not None else ""
            message = _APP_EXITED.format(output=output)
            raise AssertionError(message)
        if time.monotonic() > deadline:
            process.kill()
            raise AssertionError(_APP_NEVER_RUNNING)
        time.sleep(0.05)
    worker_pid = int(pid_file.read_text(encoding="utf-8").strip())
    return process, worker_pid, marker, pid_file
