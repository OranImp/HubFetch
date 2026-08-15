"""Pure derivation helpers for the task detail view.

Progress (numeric, byte, and speed), stage-rail statuses, and the status
severity mapping are pure functions of an immutable snapshot/event stream.
Keeping them free of widgets makes them unit-testable without a Qt event loop
and keeps the detail view focused on composition only.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from hubfetch.domain.events import TransferProgressedEvent
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.ui.tasks.texts import STAGE_ORDER
from hubfetch.ui.widgets.stage_rail import StageReport, StageStatus
from hubfetch.ui.widgets.status import StatusSeverity

if TYPE_CHECKING:
    from hubfetch.domain.events import PersistedEvent
    from hubfetch.domain.lifecycle import TransferStage

_BYTES: Final[tuple[tuple[int, str], ...]] = (
    (1024**4, "TiB"),
    (1024**3, "GiB"),
    (1024**2, "MiB"),
    (1024, "KiB"),
)
_KIB: Final[int] = 1024
_MIN_PROGRESS_SAMPLES: Final[int] = 2


def format_bytes(value: int) -> str:
    """Format a byte count as ``12.3 MiB`` without losing integer fidelity."""
    if value < _KIB:
        return f"{value} B"
    for scale, suffix in _BYTES:
        if value >= scale:
            return f"{value / scale:.1f} {suffix}"
    return f"{value} B"


def severity_for_state(state: LifecycleState) -> StatusSeverity:
    """Map a lifecycle state onto the status severity vocabulary."""
    match state:
        case LifecycleState.QUEUED:
            return StatusSeverity.QUEUED
        case LifecycleState.RUNNING | LifecycleState.CANCELLING:
            return StatusSeverity.ACTIVE
        case LifecycleState.SUCCEEDED:
            return StatusSeverity.SUCCEEDED
        case LifecycleState.FAILED:
            return StatusSeverity.FAILED
        case LifecycleState.CANCELLED:
            return StatusSeverity.CANCELLED
        case LifecycleState.INTERRUPTED:
            return StatusSeverity.INTERRUPTED


class ProgressReading:
    """Numeric, byte, and speed progress derived from the two latest events."""

    def __init__(self, events: tuple[PersistedEvent, ...]) -> None:
        """Compute a reading from the tail of the event stream."""
        self.fraction: float | None = None
        self.detail: str = ""
        progressed = [
            event for event in events if isinstance(event, TransferProgressedEvent)
        ]
        if not progressed:
            self.detail = "—"
            return
        latest = progressed[-1]
        if latest.bytes_total > 0:
            self.fraction = latest.bytes_done / latest.bytes_total
        speed = ""
        if len(progressed) >= _MIN_PROGRESS_SAMPLES:
            previous = progressed[-2]
            elapsed = (latest.occurred_at - previous.occurred_at).total_seconds()
            delta = latest.bytes_done - previous.bytes_done
            if elapsed > 0 and delta >= 0:
                speed = f" · {format_bytes(int(delta / elapsed))}/s"
        self.detail = (
            f"{format_bytes(latest.bytes_done)} / "
            f"{format_bytes(latest.bytes_total)}{speed}"
        )


def _latest_progress_stage(
    events: tuple[PersistedEvent, ...],
) -> TransferStage | None:
    """Return the most recently reported transfer stage, if any."""
    latest: TransferStage | None = None
    for event in events:
        if isinstance(event, TransferProgressedEvent):
            latest = event.stage
    return latest


def stage_reports(
    task_state: LifecycleState, events: tuple[PersistedEvent, ...]
) -> tuple[StageReport, ...]:
    """Derive stage statuses from the task state and latest progress stage."""
    latest = _latest_progress_stage(events)
    reports: list[StageReport] = []
    for index, stage in enumerate(STAGE_ORDER):
        status = _status_for(task_state, index, latest)
        reports.append(StageReport(stage=stage, status=status))
    return tuple(reports)


def _status_for(
    task_state: LifecycleState,
    index: int,
    latest: TransferStage | None,
) -> StageStatus:
    """Pick the one status for a stage under the current task state."""
    match task_state:
        case LifecycleState.SUCCEEDED:
            return StageStatus.DONE
        case LifecycleState.FAILED:
            return _failed_status(index, latest)
        case LifecycleState.CANCELLED | LifecycleState.INTERRUPTED:
            return _stopped_status(index, latest)
        case LifecycleState.RUNNING | LifecycleState.CANCELLING:
            return _active_status(index, latest)
        case LifecycleState.QUEUED:
            return StageStatus.PENDING


def _active_status(index: int, latest: TransferStage | None) -> StageStatus:
    """Running/cancelling: done before, active at, pending after the stage."""
    if latest is None:
        return StageStatus.PENDING
    latest_index = STAGE_ORDER.index(latest)
    if index < latest_index:
        return StageStatus.DONE
    if index == latest_index:
        return StageStatus.ACTIVE
    return StageStatus.PENDING


def _failed_status(index: int, latest: TransferStage | None) -> StageStatus:
    """Failed: done before, failed at, skipped after the failing stage."""
    if latest is None:
        return StageStatus.PENDING
    latest_index = STAGE_ORDER.index(latest)
    if index < latest_index:
        return StageStatus.DONE
    if index == latest_index:
        return StageStatus.FAILED
    return StageStatus.SKIPPED


def _stopped_status(index: int, latest: TransferStage | None) -> StageStatus:
    """Cancelled/interrupted: done before, skipped at and after the stop."""
    if latest is None:
        return StageStatus.PENDING
    latest_index = STAGE_ORDER.index(latest)
    if index < latest_index:
        return StageStatus.DONE
    return StageStatus.SKIPPED


__all__ = [
    "ProgressReading",
    "format_bytes",
    "severity_for_state",
    "stage_reports",
]
