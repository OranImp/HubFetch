"""Deterministic process-tree fixtures for Windows Job Object containment tests.

Fixture processes are spawned with the real CPython executable behind the venv
launcher stub (``_base_executable``) so every spawn is a single process image
and containment assertions are deterministic. The parent blocks on stdin until
the test triggers the child spawn, which lets the test assign the parent to a
job first and then prove the later child joins the same job. The parent reports
its child PID through a file, keeping the channel fully typed and free of pipe
lifecycle races.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from typing import TYPE_CHECKING, Final, final

from hubfetch.platform.windows.job_object import (
    JobObject,
    OpenProcessError,
    open_process,
)

if TYPE_CHECKING:
    from pathlib import Path

_POLL_INTERVAL_SECONDS: Final = 0.05
_CHILD_READY_TIMEOUT_SECONDS: Final = 5.0


class FixtureError(RuntimeError):
    """A process-tree fixture contract was violated."""

    def __init__(self, *, reason: str) -> None:
        super().__init__(reason)


class ProcessTreeTimeoutError(TimeoutError):
    """A bounded process observation exceeded its deadline."""

    def __init__(self, *, reason: str) -> None:
        super().__init__(reason)


def fixture_interpreter() -> str:
    """Return the real CPython executable behind a uv venv launcher stub.

    The venv ``python.exe`` is a launcher that spawns the actual interpreter as
    a separate process; using the base executable keeps every fixture process a
    single image so job membership and leak assertions are deterministic.
    """
    base = getattr(sys, "_base_executable", None)
    return base if isinstance(base, str) and base else sys.executable


def _parent_script(pid_file: Path) -> str:
    """Build the blocked-parent script that writes its child PID to a file."""
    pid_file_literal = json.dumps(str(pid_file))
    return (
        "import subprocess, sys, threading;"
        "sys.stdin.readline();"
        "child = subprocess.Popen([sys.executable, '-c', 'import threading;"
        " threading.Event().wait()']);"
        f"open({pid_file_literal}, 'w').write(str(child.pid));"
        "threading.Event().wait()"
    )


def _parse_pid(text: str) -> int:
    """Parse a PID from the reported child-ready payload."""
    try:
        return int(text)
    except ValueError as error:
        raise FixtureError(reason=f"malformed child pid {text!r}") from error


@final
class BlockedTree:
    """A blocked parent process that spawns one blocked child after a trigger."""

    __slots__: Final = ("_child_pid", "_parent", "_pid_file")
    _parent: subprocess.Popen[str]
    _pid_file: Path
    _child_pid: int | None

    def __init__(self, parent: subprocess.Popen[str], pid_file: Path) -> None:
        """Own the freshly spawned blocked parent process and its pid channel."""
        self._parent = parent
        self._pid_file = pid_file
        self._child_pid = None

    @property
    def parent_pid(self) -> int:
        """Return the root process identifier."""
        return self._parent.pid

    @property
    def has_child(self) -> bool:
        """Return whether the child spawn was already triggered."""
        return self._child_pid is not None

    @property
    def child_pid(self) -> int:
        """Return the child process identifier once spawned."""
        if self._child_pid is None:
            raise FixtureError(reason="child has not been spawned yet")
        return self._child_pid

    def parent_is_running(self) -> bool:
        """Return whether the root process is still alive."""
        return self._parent.poll() is None

    def wait_parent(self, timeout_seconds: float) -> int:
        """Wait for the root process to exit within a bound and return its code."""
        return self._parent.wait(timeout=timeout_seconds)

    def spawn_child(self) -> int:
        """Trigger the parent to spawn its blocked child and return its PID."""
        if self._child_pid is None:
            self._child_pid = self._request_child_pid()
        return self._child_pid

    def close_pipes(self) -> None:
        """Close every parent pipe so no file wrapper outlives the fixture."""
        for stream in (self._parent.stdin, self._parent.stdout, self._parent.stderr):
            if stream is not None:
                stream.close()

    def _request_child_pid(self) -> int:
        stdin = self._parent.stdin
        if stdin is None:
            raise FixtureError(reason="parent stdin was closed")
        stdin.write("go\n")
        stdin.flush()
        deadline = time.monotonic() + _CHILD_READY_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if self._pid_file.exists():
                text = self._pid_file.read_text(encoding="utf-8").strip()
                return _parse_pid(text)
            time.sleep(_POLL_INTERVAL_SECONDS)
        raise ProcessTreeTimeoutError(reason="parent did not report its child in time")


def spawn_blocked_tree(pid_file: Path) -> BlockedTree:
    """Spawn a blocked parent that spawns a blocked child only after a trigger."""
    parent = subprocess.Popen(  # noqa: S603
        [fixture_interpreter(), "-c", _parent_script(pid_file)],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return BlockedTree(parent, pid_file)


def wait_for_job_empty(job: JobObject, *, timeout_seconds: float) -> None:
    """Observe a job become empty within a hard deadline.

    The bounded empty-job observation is the authoritative proof that
    termination converged; ``TerminateJobObject``'s return value alone is never
    treated as proof. The deadline failure is a typed error, not a silent pass.
    """
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not job.active_process_ids():
            return
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise ProcessTreeTimeoutError(reason="job did not become empty within the bound")


def wait_for_process_exit(pid: int, *, timeout_seconds: float) -> None:
    """Observe a PID stop opening a process handle within a hard deadline."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            with open_process(pid):
                pass
        except OpenProcessError:
            return
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise ProcessTreeTimeoutError(reason=f"process {pid} did not exit within the bound")


def force_cleanup(tree: BlockedTree, *, timeout_seconds: float) -> None:
    """Force-kill every fixture process within a bound; no-op when already gone."""
    targets = [tree.parent_pid]
    if tree.has_child:
        targets.append(tree.child_pid)
    for pid in targets:
        if shutil.which("taskkill") is not None:
            subprocess.run(  # noqa: S603
                [shutil.which("taskkill") or "taskkill", "/PID", str(pid), "/T", "/F"],
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
            )
    try:
        tree.wait_parent(timeout_seconds)
    except subprocess.TimeoutExpired as error:
        raise ProcessTreeTimeoutError(
            reason=f"fixture tree {tree.parent_pid} survived force cleanup"
        ) from error
    tree.close_pipes()


__all__: Final = (
    "BlockedTree",
    "FixtureError",
    "ProcessTreeTimeoutError",
    "fixture_interpreter",
    "force_cleanup",
    "spawn_blocked_tree",
    "wait_for_job_empty",
    "wait_for_process_exit",
)
