"""Windows-only fixtures for the worker QProcess transport tests."""

from __future__ import annotations

import sys
from contextlib import contextmanager
from typing import TYPE_CHECKING, Final

from hubfetch.platform.windows.job_object import JobObject
from hubfetch.runtime.worker_process import WorkerProcess

if TYPE_CHECKING:
    from collections.abc import Generator
    from pathlib import Path

    from PySide6.QtCore import QProcessEnvironment

READY_TIMEOUT_MS: Final = 10_000


class Recorder:
    """Typed signal recorder used by every Windows integration test."""

    items: list[str]
    stderr_lines: list[str]

    def __init__(self) -> None:
        self.items = []
        self.stderr_lines = []

    def ready(self, _pid: int) -> None:
        self.items.append("ready")

    def assigned(self, _pid: int) -> None:
        self.items.append("assigned")

    def command(self, kind: str) -> None:
        self.items.append(f"command:{kind}")

    def failure(self, code: str, _detail: str) -> None:
        self.items.append(f"failed:{code}")

    def exited(self, code: int) -> None:
        self.items.append(f"exit:{code}")

    def terminal(self, kind: str) -> None:
        self.items.append(f"terminal:{kind}")

    def stderr(self, line: str) -> None:
        self.stderr_lines.append(line)


def write_script(tmp_path: Path, source: str) -> Path:
    """Write one rogue worker script and return its path."""
    path = tmp_path / "worker_script.py"
    _ = path.write_text(source, encoding="utf-8")
    return path


def rogue_ready_then_duplicate_terminal() -> str:
    """A worker that emits ready then two terminal events in one flush."""
    return (
        "import sys\n"
        "from hubfetch.domain.ids import parse_task_id, parse_attempt_id\n"
        "from hubfetch.domain.ipc import SucceededEvent, WorkerReadyEvent\n"
        "from hubfetch.runtime.jsonl_transport import encode_event_frame\n"
        "out = sys.stdout.buffer\n"
        "tid = parse_task_id('t'); aid = parse_attempt_id('a')\n"
        "out.write(encode_event_frame(WorkerReadyEvent(), 0))\n"
        "out.flush()\n"
        "out.write(encode_event_frame(SucceededEvent(task_id=tid,"
        " attempt_id=aid), 1))\n"
        "out.write(encode_event_frame(SucceededEvent(task_id=tid,"
        " attempt_id=aid), 2))\n"
        "out.flush()\n"
        "sys.stdin.buffer.read()\n"
    )


def rogue_sentinel_before_ready(sentinel_path: str) -> str:
    """A worker that touches a sentinel file before any ready event."""
    return (
        f"import sys, pathlib\n"
        f"pathlib.Path({sentinel_path!r}).write_text('touched')\n"
        "from hubfetch.domain.ids import parse_task_id, parse_attempt_id\n"
        "from hubfetch.domain.ipc import ProgressEvent, WorkerReadyEvent\n"
        "from hubfetch.runtime.jsonl_transport import encode_event_frame\n"
        "out = sys.stdout.buffer\n"
        "tid = parse_task_id('t'); aid = parse_attempt_id('a')\n"
        "out.write(encode_event_frame(ProgressEvent(task_id=tid, attempt_id=aid,"
        " bytes_done=1, bytes_total=1), 0))\n"
        "out.write(encode_event_frame(WorkerReadyEvent(), 1))\n"
        "out.flush()\n"
        "sys.stdin.buffer.read()\n"
    )


def rogue_early_exit() -> str:
    """A worker that exits before emitting anything."""
    return "import sys\nsys.exit(3)\n"


def rogue_silent_block() -> str:
    """A worker that never emits ready and blocks forever."""
    return "import threading\nthreading.Event().wait()\n"


@contextmanager
def launched_worker(
    *,
    argv: tuple[str, ...],
    environment: QProcessEnvironment,
    ready_timeout_ms: int = READY_TIMEOUT_MS,
) -> Generator[WorkerProcess, None, None]:
    """Yield a started transport and terminate the tree plus Job afterwards."""
    job = JobObject()
    worker = WorkerProcess(
        argv=argv,
        environment=environment,
        job=job,
        ready_timeout_ms=ready_timeout_ms,
    )
    try:
        worker.start()
        yield worker
    finally:
        if worker.is_running:
            worker.terminate()
        job.close()


def rogue_argv(tmp_path: Path, source: str) -> tuple[str, ...]:
    """Build the argv for a rogue worker script."""
    return (sys.executable, "-u", str(write_script(tmp_path, source)))
