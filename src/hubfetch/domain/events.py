"""Strict persisted event variants recorded in the HubFetch transaction store.

Every persisted event is a discriminated union so an unknown event tag is a
parse failure. Event payloads intentionally carry no free-text fields that
could smuggle secret bytes; sanitized diagnostics belong to the separate
redaction/observability boundary.
"""

from datetime import datetime
from typing import Annotated, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field

from .ids import AttemptId, EventId, TaskId
from .lifecycle import LifecycleState, TransferStage


class StrictModel(BaseModel):
    """Frozen boundary model that rejects unknown fields and stores no secrets."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)


class PersistedEventBase(StrictModel):
    """Fields shared by every persisted event."""

    event_id: EventId
    task_id: TaskId
    attempt_id: AttemptId
    occurred_at: datetime


class TaskQueuedEvent(PersistedEventBase):
    """A task attempt entered the queue."""

    kind: Literal["task_queued"] = "task_queued"


class TaskTransitionedEvent(PersistedEventBase):
    """An attempt moved from one lifecycle state to another."""

    kind: Literal["task_transitioned"] = "task_transitioned"
    from_state: LifecycleState
    to_state: LifecycleState


class TransferProgressedEvent(PersistedEventBase):
    """Byte progress recorded during the transfer stage."""

    kind: Literal["transfer_progressed"] = "transfer_progressed"
    stage: TransferStage
    bytes_done: int = Field(ge=0)
    bytes_total: int = Field(ge=0)


class TaskRecoveredEvent(PersistedEventBase):
    """Startup recovery converted an abandoned active attempt."""

    kind: Literal["task_recovered"] = "task_recovered"
    from_state: LifecycleState
    to_state: LifecycleState = LifecycleState.INTERRUPTED


PersistedEvent = Annotated[
    TaskQueuedEvent
    | TaskTransitionedEvent
    | TransferProgressedEvent
    | TaskRecoveredEvent,
    Field(discriminator="kind"),
]
