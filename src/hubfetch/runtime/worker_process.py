"""GUI-side QProcess transport with typed preflight and envelope gating.

The transport owns the worker's launch lifecycle: start with a sanitized
environment, wait for ``worker_ready``, assign the live process to the
retained kill-on-close Job, then release the non-secret task envelope over
stdin. On timeout, malformed or unknown output, duplicate or out-of-order
sequences, early exit, or assignment failure the envelope is withheld, the
Job is terminated, and a typed :class:`PreflightFailure` is reported for
later persistence.
"""

from __future__ import annotations

from contextlib import suppress
from typing import TYPE_CHECKING, Final, final

from PySide6.QtCore import QObject, QProcess, QProcessEnvironment, QTimer, Signal

from hubfetch.platform.windows.job_object import (
    AssignProcessError,
    JobObject,
    JobObjectClosedError,
    JobObjectError,
    OpenProcessError,
    open_process,
)
from hubfetch.runtime.jsonl_transport import (
    TransportProtocolError,
    encode_command_frame,
)
from hubfetch.runtime.worker_event_router import RoutedEvent, WorkerEventRouter
from hubfetch.runtime.worker_process_types import (
    DEFAULT_READY_TIMEOUT_MS,
    PreflightFailure,
    WorkerProcessStateError,
)
from hubfetch.security.redaction import Redactor

if TYPE_CHECKING:
    from hubfetch.domain.ipc import GuiCommand


@final
class WorkerProcess(QObject):
    """One launched worker supervised through its contained boot handshake.

    Signals: ``ready(pid)``, ``assigned(pid)``, ``command_sent(kind)``,
    ``event_received(kind)``, ``terminal_event(kind)``,
    ``preflight_failed(code, detail)``, ``process_exited(code)``, and
    ``stderr_sanitized(text)``.
    """

    ready = Signal(int)
    assigned = Signal(int)
    command_sent = Signal(str)
    event_received = Signal(str)
    terminal_event = Signal(str)
    preflight_failed = Signal(str, str)
    process_exited = Signal(int)
    stderr_sanitized = Signal(str)

    __slots__: Final = (
        "_argv",
        "_assigned",
        "_command_sequence",
        "_envelope_sent",
        "_environment",
        "_failed",
        "_job",
        "_process",
        "_ready_timer",
        "_redactor",
        "_router",
    )

    def __init__(
        self,
        *,
        argv: tuple[str, ...],
        environment: QProcessEnvironment,
        job: JobObject,
        ready_timeout_ms: int = DEFAULT_READY_TIMEOUT_MS,
    ) -> None:
        """Own the launch configuration and the bounded ready timer."""
        super().__init__()
        self._argv = argv
        self._environment = environment
        self._job = job
        self._process = QProcess(self)
        self._router = WorkerEventRouter()
        self._redactor = Redactor()
        self._assigned = False
        self._envelope_sent = False
        self._failed: PreflightFailure | None = None
        self._command_sequence = 0
        self._ready_timer = QTimer(self)
        self._ready_timer.setSingleShot(True)
        self._ready_timer.setInterval(ready_timeout_ms)

    @property
    def pid(self) -> int | None:
        """Return the live process identifier, or ``None`` before launch."""
        value = self._process.processId()
        return value or None

    @property
    def is_running(self) -> bool:
        """Return whether the worker process is currently running."""
        return self._process.state() == QProcess.ProcessState.Running

    @property
    def failed(self) -> PreflightFailure | None:
        """Return the typed preflight failure, or ``None`` while it is clean."""
        return self._failed

    def start(self) -> None:
        """Configure and launch the worker with its sanitized environment."""
        process = self._process
        process.setProgram(self._argv[0])
        process.setArguments(list(self._argv[1:]))
        process.setProcessEnvironment(self._environment)
        _ = process.readyReadStandardOutput.connect(self._on_stdout)
        _ = process.readyReadStandardError.connect(self._on_stderr)
        _ = process.finished.connect(self._on_finished)
        _ = process.errorOccurred.connect(self._on_error)
        _ = self._ready_timer.timeout.connect(self._on_ready_timeout)
        self._ready_timer.start()
        process.start()

    def assign(self) -> None:
        """Open the live process and assign it to the retained Job.

        Raises :class:`WorkerProcessStateError` when called before
        ``worker_ready``; on a Win32 assignment failure the failure is
        reported through ``preflight_failed`` and the Job is terminated.
        """
        if self._failed is not None:
            raise WorkerProcessStateError(
                reason="cannot assign after a preflight failure"
            )
        if not self._router.ready:
            raise WorkerProcessStateError(reason="cannot assign before worker_ready")
        if self._assigned:
            return
        pid = self.pid
        if pid is None:
            self._fail_preflight(
                "assignment_failed", "the worker process identifier is unavailable"
            )
            return
        try:
            with open_process(pid) as process:
                self._job.assign(process)
        except (OpenProcessError, AssignProcessError, JobObjectClosedError) as error:
            self._fail_preflight("assignment_failed", str(error))
            return
        self._assigned = True
        self.assigned.emit(pid)

    def send_envelope(self, command: GuiCommand) -> None:
        """Send the non-secret discriminated task envelope over stdin.

        The envelope is the release: it may be sent only once, and only after
        the worker is both ready and assigned to the Job.
        """
        self._require_release("the task envelope")
        if self._envelope_sent:
            raise WorkerProcessStateError(reason="the task envelope was already sent")
        self._envelope_sent = True
        self._write_command(command)

    def send_command(self, command: GuiCommand) -> None:
        """Send one later command (cancel or shutdown) to the released worker."""
        self._require_release("commands")
        self._write_command(command)

    def terminate(self) -> None:
        """Bounded hard-stop: terminate the Job tree and the root process."""
        self._ready_timer.stop()
        self._terminate_job()
        if self._process.state() != QProcess.ProcessState.NotRunning:
            self._process.kill()

    def _require_release(self, what: str) -> None:
        """Raise a typed state error when the release gate is not satisfied."""
        if self._failed is not None:
            raise WorkerProcessStateError(
                reason=f"cannot send {what} after a preflight failure"
            )
        if not (self._router.ready and self._assigned):
            raise WorkerProcessStateError(
                reason=f"{what} require a ready and assigned worker"
            )

    def _write_command(self, command: GuiCommand) -> None:
        """Encode one command frame with the next command sequence."""
        frame = encode_command_frame(command, self._command_sequence)
        self._command_sequence += 1
        _ = self._process.write(frame)
        self.command_sent.emit(command.kind)

    def _on_stdout(self) -> None:
        """Parse one stdout chunk and route it through the ready gate."""
        if self._failed is not None:
            return
        raw = bytes(self._process.readAllStandardOutput().data())
        try:
            routed = self._router.feed(raw)
        except TransportProtocolError as error:
            self._fail_preflight(error.code, error.detail)
            return
        for item in routed:
            self._route(item)

    def _route(self, item: RoutedEvent) -> None:
        """Emit transport signals for one handshake-routed worker event."""
        self.event_received.emit(item.kind)
        if item.kind == "worker_ready":
            self._ready_timer.stop()
            self.ready.emit(self.pid or 0)
            return
        if item.terminal:
            self.terminal_event.emit(item.kind)

    def _on_stderr(self) -> None:
        """Redact and forward one chunk of worker stderr diagnostic text."""
        raw = bytes(self._process.readAllStandardError().data())
        text = raw.decode("utf-8", errors="replace")
        sanitized = self._redactor.redact_text(text)
        if sanitized:
            self.stderr_sanitized.emit(sanitized)

    def _on_finished(self, exit_code: int, _exit_status: QProcess.ExitStatus) -> None:
        """Observe process exit and classify an exit before ready as a failure."""
        self._ready_timer.stop()
        if self._failed is None and not self._router.ready:
            self._fail_preflight(
                "early_exit",
                f"the worker exited with code {exit_code} before worker_ready",
            )
            return
        self.process_exited.emit(exit_code)

    def _on_error(self, error: QProcess.ProcessError) -> None:
        """Map QProcess launch and crash errors to typed preflight failures."""
        if self._failed is not None:
            return
        if error == QProcess.ProcessError.FailedToStart:
            self._fail_preflight(
                "failed_to_start", "the worker executable could not be started"
            )
            return
        if error == QProcess.ProcessError.Crashed and not self._router.ready:
            self._fail_preflight("early_exit", "the worker crashed before worker_ready")

    def _on_ready_timeout(self) -> None:
        """Fail the preflight when ``worker_ready`` never arrives in time."""
        self._fail_preflight(
            "ready_timeout", "the worker did not emit worker_ready within the bound"
        )

    def _fail_preflight(self, code: str, detail: str) -> None:
        """Record, contain, and report one typed preflight failure."""
        if self._failed is not None:
            return
        self._failed = PreflightFailure(code=code, detail=detail, pid=self.pid)
        self._ready_timer.stop()
        self._terminate_job()
        self.preflight_failed.emit(code, detail)

    def _terminate_job(self) -> None:
        """Terminate every Job member; a closed or already-empty Job is fine."""
        with suppress(JobObjectError):
            self._job.terminate()
