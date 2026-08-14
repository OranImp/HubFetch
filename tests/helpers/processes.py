"""Event-driven process helpers with bounded Windows tree cleanup."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import Event, Lock, Thread
from typing import TYPE_CHECKING, Final, final

if TYPE_CHECKING:
    from collections.abc import Generator, Mapping, Sequence
    from typing import TextIO


@dataclass(frozen=True, slots=True)
class RunNamespace:
    """Hold unique roots for one test process run."""

    name: str
    root: Path
    app_root: Path
    cache_root: Path
    temp_root: Path
    evidence_root: Path

    @property
    def namespace(self) -> str:
        """Return the stable per-run namespace label."""
        return self.name


@contextmanager
def create_run_namespace(
    parent: Path | None = None,
) -> Generator[RunNamespace, None, None]:
    """Create and remove unique app, cache, temp, and evidence roots."""
    root = Path(
        tempfile.mkdtemp(
            prefix="hubfetch-run-",
            dir=str(parent) if parent is not None else None,
        )
    )
    app_root = root / "app-data"
    cache_root = root / "cache"
    temp_root = root / "temp"
    evidence_root = root / "evidence"
    for directory in (app_root, cache_root, temp_root, evidence_root):
        directory.mkdir()
    namespace = RunNamespace(
        name=root.name,
        root=root,
        app_root=app_root,
        cache_root=cache_root,
        temp_root=temp_root,
        evidence_root=evidence_root,
    )
    try:
        yield namespace
    finally:
        shutil.rmtree(root)


class ProcessNotStartedError(RuntimeError):
    """Indicate that a process operation needs a started process."""

    def __init__(self) -> None:
        super().__init__("process has not started")


class ProcessAlreadyStartedError(RuntimeError):
    """Indicate that a managed process was started more than once."""

    def __init__(self) -> None:
        super().__init__("process has already started")


class ProcessReadyTimeoutError(RuntimeError):
    """Indicate that a process did not emit its ready token in time."""

    def __init__(self, pid: int, token: str) -> None:
        super().__init__(f"process {pid} did not emit {token!r}")


class ProcessLeakError(RuntimeError):
    """Indicate that a managed process remains alive."""

    def __init__(self, pid: int) -> None:
        super().__init__(f"process tree rooted at {pid} is still running")


class ProcessTerminationError(RuntimeError):
    """Indicate that bounded process-tree termination failed."""

    def __init__(self, pid: int) -> None:
        super().__init__(f"process tree rooted at {pid} did not terminate")


@dataclass(frozen=True, slots=True)
class TerminationReceipt:
    """Record the observable result of bounded process cleanup."""

    pid: int
    returncode: int | None
    tree_terminated: bool
    command_output: str


@final
class ManagedProcess:
    """Launch a process and synchronize readiness through stdout events."""

    __slots__: Final = (
        "_argv",
        "_cwd",
        "_env",
        "_output",
        "_output_lock",
        "_popen",
        "_reader",
        "_ready_event",
        "_ready_token",
    )
    _argv: tuple[str, ...]
    _cwd: Path
    _env: dict[str, str] | None
    _output: list[str]
    _output_lock: Lock
    _popen: subprocess.Popen[str] | None
    _ready_event: Event
    _ready_token: str
    _reader: Thread | None

    def __init__(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        environment: Mapping[str, str] | None = None,
        ready_marker: str = "READY",
    ) -> None:
        self._argv = tuple(argv)
        self._cwd = cwd
        self._env = dict(environment) if environment is not None else None
        self._ready_token = ready_marker
        self._ready_event = Event()
        self._output = []
        self._output_lock = Lock()
        self._popen = None
        self._reader = None

    @property
    def pid(self) -> int:
        """Return the child process identifier after start."""
        if self._popen is None:
            raise ProcessNotStartedError
        return self._popen.pid

    @property
    def is_running(self) -> bool:
        """Return whether the root process is still running."""
        return self._popen is not None and self._popen.poll() is None

    @property
    def returncode(self) -> int | None:
        """Return the root process exit code when available."""
        if self._popen is None:
            raise ProcessNotStartedError
        return self._popen.returncode

    @property
    def output(self) -> tuple[str, ...]:
        """Return captured stdout lines in arrival order."""
        with self._output_lock:
            return tuple(self._output)

    def start(self) -> None:
        """Start the process and its stdout event reader."""
        if self._popen is not None:
            raise ProcessAlreadyStartedError
        self._popen = subprocess.Popen(  # noqa: S603
            self._argv,
            cwd=str(self._cwd),
            env=self._env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            creationflags=0,
        )
        stdout = self._popen.stdout
        assert stdout is not None
        self._reader = Thread(
            target=self._read_output,
            args=(stdout,),
            daemon=True,
        )
        self._reader.start()

    def wait_ready(self, timeout_seconds: float) -> None:
        """Wait for the ready token without polling or sleeping."""
        if self._popen is None:
            raise ProcessNotStartedError
        if self._ready_event.wait(timeout_seconds):
            return
        raise ProcessReadyTimeoutError(self.pid, self._ready_token)

    def wait(self, timeout_seconds: float) -> None:
        """Wait for the root process to exit within a bound."""
        if self._popen is None:
            raise ProcessNotStartedError
        _ = self._popen.wait(timeout=timeout_seconds)
        self._close_output(timeout_seconds)

    def terminate_root(self) -> None:
        """Request graceful termination of the root process."""
        if self._popen is None:
            raise ProcessNotStartedError
        self._popen.terminate()

    def kill_root(self) -> None:
        """Force termination of the root process."""
        if self._popen is None:
            raise ProcessNotStartedError
        self._popen.kill()

    def _read_output(self, stream: TextIO) -> None:
        for line in stream:
            value = line.rstrip("\r\n")
            with self._output_lock:
                self._output.append(value)
            if self._ready_token in value:
                self._ready_event.set()

    def _close_output(self, timeout_seconds: float) -> None:
        if self._reader is not None:
            self._reader.join(timeout_seconds)
        if self._popen is not None and self._popen.stdout is not None:
            self._popen.stdout.close()


def terminate_process_tree(
    process: ManagedProcess, *, timeout_seconds: float
) -> TerminationReceipt:
    """Terminate a root process and descendants within a bounded timeout."""
    if not process.is_running:
        return TerminationReceipt(
            pid=process.pid,
            returncode=process.returncode,
            tree_terminated=True,
            command_output="",
        )
    if shutil.which("taskkill") is not None:
        result = subprocess.run(  # noqa: S603
            [
                shutil.which("taskkill") or "taskkill",
                "/PID",
                str(process.pid),
                "/T",
                "/F",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        command_output = f"{result.stdout}{result.stderr}"
    else:
        process.terminate_root()
        command_output = "terminate"
    try:
        process.wait(timeout_seconds)
    except subprocess.TimeoutExpired:
        process.kill_root()
        try:
            process.wait(timeout_seconds)
        except subprocess.TimeoutExpired as error:
            raise ProcessTerminationError(process.pid) from error
    returncode = process.returncode
    if process.is_running:
        raise ProcessTerminationError(process.pid)
    return TerminationReceipt(
        pid=process.pid,
        returncode=returncode,
        tree_terminated=True,
        command_output=command_output,
    )


def assert_process_tree_clean(process: ManagedProcess) -> None:
    """Raise with the root PID when a process tree remains alive."""
    if process.is_running:
        raise ProcessLeakError(process.pid)
