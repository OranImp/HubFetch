"""Application runtime facade over the composed transfer lifecycle.

# noqa: SIZE_OK - one facade module must own the full runtime surface: the Qt
# signals, every lifecycle command, the supervisor/cancellation wiring, and the
# bounded teardown; splitting it would scatter one cohesive composition.

The runtime is the GUI-facing surface of Todo 21's composition: it owns the
single-owner FIFO scheduler, the typed create/cancel/retry commands, the active
Job/supervisor set, the cooperative cancellation controllers, and the bounded
orderly shutdown. It deliberately stays free of transfer/network work (every
transfer runs in a contained worker subprocess), free of a service locator and
mutable singletons (all collaborators are constructor-injected), and free of UI
imports. Progress/event persistence is owned by the transactional repository:
every lifecycle transition and sanitized event is committed there, and
:meth:`Runtime.record_progress` exposes the repository's typed progress seam
for UI-facing consumers.

The runtime is a Qt ``QObject`` so its typed signals are the bridge the UI
layer connects to without any UI import reaching the domain services. A tiny
:class:`_RuntimeObserver` adapter bridges the GUI-free scheduler observer
protocol to those signals, keeping the runtime's public surface purely
signal-based. The pure contract types live in
:mod:`hubfetch.application.runtime_contracts` and are re-exported here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, assert_never, final, override

from PySide6.QtCore import QObject, Signal

from hubfetch.domain.lifecycle import (
    AttemptRef,
    LifecycleState,
    TransferStage,
    is_terminal,
)
from hubfetch.domain.task_spec import (
    GitCloneSpec,
    ProxyMode,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)
from hubfetch.network.proxy import ProxyPolicy, build_proxy_policy
from hubfetch.persistence.records import TaskNotFoundError
from hubfetch.runtime.cancellation import (
    CancellationConfig,
    CancellationController,
    ContainedWorker,
)
from hubfetch.runtime.process_environment import (
    git_worker_environment,
    hub_worker_environment,
)
from hubfetch.runtime.scheduler import Scheduler, SchedulerObserver
from hubfetch.runtime.shutdown import RuntimeShutdown
from hubfetch.runtime.supervisor import Supervisor, SupervisorConfig
from hubfetch.worker.dispatch import (
    CREDENTIAL_ALIAS_ENV,
    HUB_CACHE_ENV,
    HUB_ENDPOINT_ENV,
)

from .runtime_contracts import (
    ActiveTaskNotRunningError,
    CancelOutcome,
    RuntimeConfig,
    RuntimeShutdownStartedError,
    TaskNotCancellableError,
    WorkerEnvOverrides,
)
from .task_service import TaskService

if TYPE_CHECKING:
    import sqlite3

    from PySide6.QtCore import QProcessEnvironment

    from hubfetch.config.settings import Settings
    from hubfetch.domain.ids import AttemptId, TaskId
    from hubfetch.domain.task_spec import TaskSpec
    from hubfetch.persistence.records import TaskRecord
    from hubfetch.persistence.task_repository import TaskRepository
    from hubfetch.runtime.scheduler import RecoveryReport

    from .snapshots import DetailSnapshot, QueueSnapshot
    from .task_service import RetryResult

__all__ = [
    "ActiveTaskNotRunningError",
    "CancelOutcome",
    "Runtime",
    "RuntimeConfig",
    "RuntimeShutdownStartedError",
    "TaskNotCancellableError",
    "WorkerEnvOverrides",
]


@final
class _RuntimeObserver(SchedulerObserver):
    """Bridge the GUI-free scheduler observer protocol to runtime signals."""

    __slots__: Final = ("_runtime",)
    _runtime: Runtime

    def __init__(self, runtime: Runtime) -> None:
        """Bind one adapter to its runtime."""
        self._runtime = runtime

    @override
    def task_started(self, task_id: TaskId, attempt_id: AttemptId) -> None:
        """Launch the contained supervisor and emit the runtime's signal."""
        self._runtime.on_claimed_task(task_id, attempt_id)

    @override
    def queue_changed(self) -> None:
        """Forward the persisted queue change to the runtime's signal."""
        self._runtime.queue_changed.emit()


@final
class Runtime(QObject):
    """Own one composed transfer runtime: scheduler, workers, and teardown."""

    task_started = Signal(str, str)
    """Emitted with the task and attempt id once a worker was launched."""

    task_running = Signal(str)
    """Emitted with the task id once its envelope was released to the worker."""

    task_terminal = Signal(str, str)
    """Emitted with the task id and committed terminal kind."""

    queue_changed = Signal()
    """Emitted whenever the persisted queue changed."""

    progress_received = Signal(str)
    """Forwarded worker event kinds for UI progress binding."""

    stderr_sanitized = Signal(str)
    """Forwarded redacted worker stderr for diagnostics surfaces."""

    __slots__: Final = (
        "_cancellations",
        "_config",
        "_connection",
        "_observer",
        "_parent_environment",
        "_repository",
        "_scheduler",
        "_settings",
        "_shutdown_pending",
        "_shutdown_started",
        "_supervisors",
        "_task_service",
    )
    _config: RuntimeConfig
    _repository: TaskRepository
    _connection: sqlite3.Connection
    _settings: Settings
    _parent_environment: dict[str, str]
    _observer: _RuntimeObserver
    _scheduler: Scheduler
    _task_service: TaskService
    _supervisors: dict[TaskId, Supervisor]
    _cancellations: dict[TaskId, CancellationController]
    _shutdown_pending: bool
    _shutdown_started: bool

    def __init__(self, *, config: RuntimeConfig) -> None:
        """Compose the scheduler and task service over the given collaborators."""
        super().__init__()
        self._config = config
        self._repository = config.repository
        self._connection = config.connection
        self._settings = config.settings
        self._parent_environment = dict(config.parent_environment)
        self._observer = _RuntimeObserver(self)
        self._scheduler = Scheduler(
            config.repository, owner=config.owner, observer=self._observer
        )
        self._task_service = TaskService(
            config.repository, on_queue_changed=self._wake_scheduler
        )
        self._supervisors = {}
        self._cancellations = {}
        self._shutdown_pending = False
        self._shutdown_started = False

    def start(self) -> RecoveryReport:
        """Acquire the runtime owner and recover interrupted tasks exactly once."""
        return self._scheduler.start()

    def mark_diagnostics_ready(self) -> None:
        """Open the diagnostics dispatch gate and wake the scheduler."""
        self._scheduler.mark_diagnostics_ready()
        self._wake_scheduler()

    def create_task(
        self, task_id: TaskId, spec: TaskSpec, attempt_id: AttemptId
    ) -> TaskRecord:
        """Persist one confirmed task as queued and wake the scheduler."""
        return self._task_service.create(task_id, spec, attempt_id)

    def cancel(self, task_id: TaskId) -> CancelOutcome:
        """Cancel a queued task without a worker, or drive active cancellation.

        Queued tasks terminalize through the compare-and-set command path with
        zero worker launch. Active tasks enter the nonterminal ``cancelling``
        state and are driven by a :class:`CancellationController` through the
        cooperative stop, the bounded escalation, and the empty-Job observation.
        """
        record = self._repository.get(task_id)
        if record is None:
            raise TaskNotFoundError(task_id=task_id)
        match record.state:
            case LifecycleState.QUEUED:
                updated = self._task_service.cancel(task_id)
                return CancelOutcome(
                    task_id=task_id,
                    state=updated.state,
                    active_cancellation=False,
                )
            case LifecycleState.RUNNING:
                return self._cancel_running(task_id, record.attempt_id)
            case LifecycleState.CANCELLING:
                raise TaskNotCancellableError(task_id=task_id, state=record.state)
            case (
                LifecycleState.SUCCEEDED
                | LifecycleState.FAILED
                | LifecycleState.CANCELLED
                | LifecycleState.INTERRUPTED
            ):
                raise TaskNotCancellableError(task_id=task_id, state=record.state)
            case _:
                assert_never(record.state)

    def retry(self, task_id: TaskId, *, new_attempt_id: AttemptId) -> RetryResult:
        """Queue a fresh linked attempt for a failed, cancelled, or interrupted task."""
        return self._task_service.retry(task_id, new_attempt_id=new_attempt_id)

    def snapshot(self) -> QueueSnapshot:
        """Return the immutable FIFO queue snapshot."""
        return self._scheduler.snapshot()

    def detail(self, task_id: TaskId) -> DetailSnapshot:
        """Return the immutable detail view of one task."""
        return self._scheduler.detail(task_id)

    def worker_argv(self, task_id: TaskId) -> tuple[str, ...]:
        """Return the bounded worker argv for one task, ending in its locator.

        Task details never appear in argv; the worker receives the task only
        through the typed envelope after Job assignment.
        """
        record = self._repository.get(task_id)
        if record is None:
            raise TaskNotFoundError(task_id=task_id)
        locator = f"{task_id}:{record.attempt_id}"
        return (*self._config.worker_command_prefix, locator)

    def worker_environment(self, task_id: TaskId) -> QProcessEnvironment:
        """Return the fresh, isolated worker environment for one task.

        The environment applies the task's typed proxy policy to a read-only
        parent snapshot and then injects the non-secret override seams. It never
        contains token bytes, only the opaque credential alias.
        """
        record = self._repository.get(task_id)
        if record is None:
            raise TaskNotFoundError(task_id=task_id)
        policy = self._proxy_policy(record.spec.proxy_mode)
        match record.spec:
            case GitCloneSpec():
                environment = git_worker_environment(self._parent_environment, policy)
            case SingleFileDownloadSpec() | SnapshotDownloadSpec():
                environment = hub_worker_environment(self._parent_environment, policy)
            case _:
                assert_never(record.spec)
        self._apply_worker_overrides(environment)
        return environment

    def record_progress(
        self,
        task_id: TaskId,
        *,
        attempt_id: AttemptId,
        stage: TransferStage,
        bytes_done: int,
        bytes_total: int,
    ) -> object:
        """Persist one sanitized byte-progress event through the repository."""
        return self._repository.record_progress(
            task_id,
            attempt_id=attempt_id,
            stage=stage,
            bytes_done=bytes_done,
            bytes_total=bytes_total,
        )

    def active_supervisor(self, task_id: TaskId) -> Supervisor | None:
        """Return the live supervisor of one task, or ``None`` when absent."""
        return self._supervisors.get(task_id)

    def shutdown(self, *, confirm_timeout_ms: int | None = None) -> RuntimeShutdown:
        """Begin the bounded orderly shutdown and return its controller.

        Dispatch stops, every active Job is terminated, the empty-Job
        observation runs, and the SQLite connection closes only after every Job
        reports zero active processes. The returned :class:`RuntimeShutdown`
        emits ``finished`` on success or ``failed`` when the bound was exceeded.
        """
        if self._shutdown_started:
            raise RuntimeShutdownStartedError
        self._shutdown_started = True
        self._shutdown_pending = True
        timeout = (
            confirm_timeout_ms
            if confirm_timeout_ms is not None
            else self._config.shutdown_confirm_timeout_ms
        )
        shutdown = RuntimeShutdown(
            scheduler=self._scheduler,
            supervisors=tuple(self._supervisors.values()),
            connection=self._connection,
            confirm_timeout_ms=timeout,
        )
        shutdown.begin()
        return shutdown

    def close(self) -> None:
        """Release every active controller and supervisor without dispatching.

        Idempotent; safe to call after a clean shutdown. Jobs are already
        closed by the shutdown path, and :class:`Supervisor.close` is itself
        idempotent.
        """
        for controller in tuple(self._cancellations.values()):
            controller.close()
        self._cancellations.clear()
        for supervisor in tuple(self._supervisors.values()):
            supervisor.close()
        self._supervisors.clear()

    def _proxy_policy(self, mode: ProxyMode) -> ProxyPolicy:
        """Build the task's typed proxy policy, seeding the manual URL only there."""
        match mode:
            case ProxyMode.MANUAL:
                return build_proxy_policy(
                    ProxyMode.MANUAL, self._settings.manual_proxy_url
                )
            case ProxyMode.SYSTEM | ProxyMode.DIRECT as inherited:
                return build_proxy_policy(inherited)
            case _:
                assert_never(mode)

    def _apply_worker_overrides(self, environment: QProcessEnvironment) -> None:
        """Inject the documented non-secret worker environment seams."""
        overrides = self._config.worker_overrides
        if overrides.hub_endpoint is not None:
            environment.insert(HUB_ENDPOINT_ENV, overrides.hub_endpoint)
        if overrides.hub_cache_dir is not None:
            environment.insert(HUB_CACHE_ENV, str(overrides.hub_cache_dir))
        if overrides.credential_alias is not None:
            environment.insert(CREDENTIAL_ALIAS_ENV, overrides.credential_alias)
        if overrides.git_config_global is not None:
            environment.insert("GIT_CONFIG_GLOBAL", str(overrides.git_config_global))
        if overrides.git_config_nosystem:
            environment.insert("GIT_CONFIG_NOSYSTEM", "1")

    def _wake_scheduler(self) -> None:
        """Run one dispatch attempt after a persisted mutation, unless closing."""
        if self._shutdown_pending:
            return
        _ = self._scheduler.dispatch()

    def _is_shutting_down(self) -> bool:
        """Return whether the runtime began its orderly shutdown."""
        return self._shutdown_pending

    def on_claimed_task(self, task_id: TaskId, attempt_id: AttemptId) -> None:
        """Launch one Job-contained worker for a freshly claimed task.

        Public because the GUI-free observer adapter in this module bridges the
        scheduler protocol to it; UI consumers use the ``task_started`` signal.
        """
        if self._shutdown_pending:
            return
        record = self._repository.get(task_id)
        if record is None or is_terminal(record.state):
            return
        supervisor = Supervisor(
            config=SupervisorConfig(
                attempt=AttemptRef(task_id=task_id, attempt_id=attempt_id),
                argv=self.worker_argv(task_id),
                environment=self.worker_environment(task_id),
                ready_timeout_ms=self._config.ready_timeout_ms,
            ),
            scheduler=self._scheduler,
            repository=self._repository,
        )
        self._supervisors[task_id] = supervisor
        _ = supervisor.task_running.connect(self.task_running)
        _ = supervisor.progress_received.connect(self.progress_received)
        _ = supervisor.stderr_sanitized.connect(self.stderr_sanitized)
        _ = supervisor.task_terminal.connect(self._on_supervisor_terminal)
        supervisor.start()
        self.task_started.emit(task_id, attempt_id)

    def _cancel_running(self, task_id: TaskId, attempt_id: AttemptId) -> CancelOutcome:
        """Drive one running attempt through the cooperative cancellation flow."""
        supervisor = self._supervisors.get(task_id)
        if supervisor is None:
            raise ActiveTaskNotRunningError(task_id=task_id)
        controller = CancellationController(
            config=CancellationConfig(
                attempt=AttemptRef(task_id=task_id, attempt_id=attempt_id),
                grace_period_ms=self._config.grace_period_ms,
                confirm_timeout_ms=self._config.confirm_timeout_ms,
                shutting_down=self._is_shutting_down,
            ),
            contained=ContainedWorker(job=supervisor.job, worker=supervisor.worker),
            scheduler=self._scheduler,
            repository=self._repository,
        )
        _ = controller.cancelled.connect(self._on_active_cancelled)
        _ = controller.failed.connect(self._on_active_failed)
        self._cancellations[task_id] = controller
        if controller.begin():
            return CancelOutcome(
                task_id=task_id,
                state=LifecycleState.CANCELLING,
                active_cancellation=True,
            )
        # The CAS lost to a racing terminal commit; report the current state.
        _ = self._cancellations.pop(task_id, None)
        current = self._repository.get(task_id)
        if current is None:
            raise TaskNotFoundError(task_id=task_id)
        return CancelOutcome(
            task_id=task_id,
            state=current.state,
            active_cancellation=False,
        )

    def _on_supervisor_terminal(self, task_id: TaskId, kind: str) -> None:
        """Clean up after an ordinary supervisor terminal transition."""
        self._finish_active(task_id, kind)

    def _on_active_cancelled(self, task_id: TaskId) -> None:
        """Clean up after a confirmed cooperative cancellation."""
        self._finish_active(task_id, "cancelled")

    def _on_active_failed(self, task_id: TaskId, kind: str) -> None:
        """Clean up after an active cancellation that terminalized as failed."""
        self._finish_active(task_id, kind)

    def _finish_active(self, task_id: TaskId, kind: str) -> None:
        """Release one task's controller and supervisor and report the outcome."""
        controller = self._cancellations.pop(task_id, None)
        if controller is not None:
            controller.close()
        supervisor = self._supervisors.pop(task_id, None)
        if supervisor is not None:
            supervisor.close()
        self.task_terminal.emit(task_id, kind)
