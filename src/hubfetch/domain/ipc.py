"""Canonical newline-delimited JSON encoding for all HubFetch wire models.

One encoder/decoder pair (:func:`encode_wire` / :func:`decode_wire`) serves
every GUI command, worker event, and persisted event. Every wire model is
frozen, rejects unknown fields, and is a discriminated union, so an unknown
tag or a credential-bearing payload fails parsing before domain dispatch.
Decode errors keep only field names and error codes -- never payload values --
so a malformed line cannot echo a secret back into diagnostics.
"""

from dataclasses import dataclass
from typing import Annotated, ClassVar, Final, Literal, override

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    ValidationError,
    field_validator,
)

from .events import PersistedEvent
from .ids import AttemptId, TaskId
from .lifecycle import TerminalResult, TransferStage
from .task_spec import TaskSpec


class StrictModel(BaseModel):
    """Frozen boundary model that rejects unknown fields and stores no secrets."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)


@dataclass(frozen=True, slots=True)
class WireBoundaryError(ValueError):
    """A wire model field failed the strict boundary contract."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid wire message: {self.reason}"


class GuiCommandBase(StrictModel):
    """Fields shared by every GUI-to-worker command."""

    task_id: TaskId
    attempt_id: AttemptId


class StartTaskCommand(GuiCommandBase):
    """Dispatch the non-secret task envelope to a ready, contained worker."""

    kind: Literal["start_task"] = "start_task"
    spec: TaskSpec


class CancelTaskCommand(GuiCommandBase):
    """Request a cooperative stop from an active worker."""

    kind: Literal["cancel_task"] = "cancel_task"


class ShutdownCommand(StrictModel):
    """Ask the worker to terminate cleanly without touching a task."""

    kind: Literal["shutdown"] = "shutdown"


GuiCommand = Annotated[
    StartTaskCommand | CancelTaskCommand | ShutdownCommand,
    Field(discriminator="kind"),
]


class WorkerEventBase(StrictModel):
    """Fields shared by every task-scoped worker event."""

    task_id: TaskId
    attempt_id: AttemptId


class WorkerReadyEvent(StrictModel):
    """The worker has initialized and is blocking for the task envelope.

    This event precedes the envelope, so it intentionally carries no task
    context; the GUI must assign the process to its Job before replying.
    """

    kind: Literal["worker_ready"] = "worker_ready"


class StageChangedEvent(WorkerEventBase):
    """The attempt entered a new transfer stage."""

    kind: Literal["stage_changed"] = "stage_changed"
    stage: TransferStage


class ProgressEvent(WorkerEventBase):
    """Byte progress within the transfer stage."""

    kind: Literal["progress"] = "progress"
    bytes_done: int = Field(ge=0)
    bytes_total: int = Field(ge=0)


class SucceededEvent(WorkerEventBase):
    """The attempt concluded successfully."""

    kind: Literal["succeeded"] = "succeeded"
    terminal_result: TerminalResult = TerminalResult.SUCCEEDED


class FailedEvent(WorkerEventBase):
    """The attempt failed with a sanitized, non-secret error code."""

    kind: Literal["failed"] = "failed"
    terminal_result: TerminalResult = TerminalResult.FAILED
    error_code: str

    @field_validator("error_code")
    @classmethod
    def _check_error_code(cls, value: str) -> str:
        if not value or "\x00" in value:
            raise WireBoundaryError(
                reason="error code is empty or contains a NUL character"
            )
        return value


class CancelledEvent(WorkerEventBase):
    """The attempt was cancelled after a confirmed cooperative stop."""

    kind: Literal["cancelled"] = "cancelled"
    terminal_result: TerminalResult = TerminalResult.CANCELLED


WorkerEvent = Annotated[
    WorkerReadyEvent
    | StageChangedEvent
    | ProgressEvent
    | SucceededEvent
    | FailedEvent
    | CancelledEvent,
    Field(discriminator="kind"),
]

WireMessage = Annotated[
    GuiCommand | WorkerEvent | PersistedEvent,
    Field(discriminator="kind"),
]

WIRE_MESSAGE_ADAPTER: Final[TypeAdapter[WireMessage]] = TypeAdapter(WireMessage)
"""Canonical parser for the newline-delimited wire messages."""


@dataclass(frozen=True, slots=True)
class DecodeErrorDetail:
    """Field location and error code retained from a failed wire parse."""

    field_name: str
    code: str


@dataclass(frozen=True, slots=True)
class IpcDecodeError(ValueError):
    """A wire line failed strict decoding without echoing its payload values."""

    details: tuple[DecodeErrorDetail, ...]

    @override
    def __str__(self) -> str:
        fields = ", ".join(
            f"{detail.field_name} ({detail.code})" for detail in self.details
        )
        return f"invalid wire message fields: {fields}"


def encode_wire(message: WireMessage) -> str:
    """Encode one wire model as a single canonical JSON line."""
    return message.model_dump_json() + "\n"


def decode_wire(line: str) -> WireMessage:
    """Decode one canonical JSON line into the matching typed wire model.

    Raises :class:`IpcDecodeError` carrying only field names and error codes
    when the line is empty, malformed, carries an unknown tag, or carries
    unknown/forbidden fields.
    """
    if not line.strip():
        raise IpcDecodeError(
            details=(DecodeErrorDetail(field_name="line", code="empty_line"),)
        )
    try:
        return WIRE_MESSAGE_ADAPTER.validate_json(line)
    except ValidationError as error:
        details = tuple(
            DecodeErrorDetail(
                field_name=".".join(str(part) for part in detail["loc"]),
                code=detail["type"],
            )
            for detail in error.errors()
        )
        raise IpcDecodeError(details=details) from error
