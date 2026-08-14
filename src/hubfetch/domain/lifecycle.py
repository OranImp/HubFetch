"""Exhaustive lifecycle, transfer-stage, and retry contracts for one attempt.

The legal lifecycle is encoded explicitly as a closed transition table::

    queued     -> running | cancelled
    running    -> cancelling | succeeded | failed | interrupted
    cancelling -> cancelled | failed | interrupted

``failed``, ``cancelled``, and ``interrupted`` return to ``queued`` only
through :func:`retry_attempt`, which creates a brand-new attempt linked to
the original. Terminal success never mutates. Every combination absent from
the table raises a typed :class:`IllegalTransitionError`; a new lifecycle
state therefore fails loudly at the transition boundary instead of being
silently swallowed.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum, unique
from typing import Final, override

from .ids import AttemptId, TaskId


@unique
class LifecycleState(StrEnum):
    """Closed lifecycle states of one task attempt."""

    QUEUED = "queued"
    RUNNING = "running"
    CANCELLING = "cancelling"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


@unique
class LifecycleEvent(StrEnum):
    """Closed events that drive the lifecycle transition function."""

    START = "start"
    CANCEL = "cancel"
    CANCEL_CONFIRMED = "cancel_confirmed"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


@unique
class TerminalResult(StrEnum):
    """Closed terminal outcomes reported after an attempt concludes."""

    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


@unique
class TransferStage(StrEnum):
    """Closed transfer stages with a fixed report ordering."""

    PREFLIGHT = "preflight"
    AUTHENTICATE = "authenticate"
    RESOLVE = "resolve"
    TRANSFER = "transfer"
    MATERIALIZE = "materialize"
    FINALIZE = "finalize"


FIXED_STAGE_ORDER: Final[tuple[TransferStage, ...]] = (
    TransferStage.PREFLIGHT,
    TransferStage.AUTHENTICATE,
    TransferStage.RESOLVE,
    TransferStage.TRANSFER,
    TransferStage.MATERIALIZE,
    TransferStage.FINALIZE,
)

_STAGE_POSITION: Final = {stage: index for index, stage in enumerate(FIXED_STAGE_ORDER)}

_TRANSITION_TABLE: Final[
    dict[tuple[LifecycleState, LifecycleEvent], LifecycleState]
] = {
    (LifecycleState.QUEUED, LifecycleEvent.START): LifecycleState.RUNNING,
    (LifecycleState.QUEUED, LifecycleEvent.CANCEL): LifecycleState.CANCELLED,
    (LifecycleState.RUNNING, LifecycleEvent.CANCEL): LifecycleState.CANCELLING,
    (LifecycleState.RUNNING, LifecycleEvent.SUCCEEDED): LifecycleState.SUCCEEDED,
    (LifecycleState.RUNNING, LifecycleEvent.FAILED): LifecycleState.FAILED,
    (LifecycleState.RUNNING, LifecycleEvent.INTERRUPTED): LifecycleState.INTERRUPTED,
    (
        LifecycleState.CANCELLING,
        LifecycleEvent.CANCEL_CONFIRMED,
    ): LifecycleState.CANCELLED,
    (LifecycleState.CANCELLING, LifecycleEvent.FAILED): LifecycleState.FAILED,
    (
        LifecycleState.CANCELLING,
        LifecycleEvent.INTERRUPTED,
    ): LifecycleState.INTERRUPTED,
}

TERMINAL_STATES: Final[frozenset[LifecycleState]] = frozenset(
    {
        LifecycleState.SUCCEEDED,
        LifecycleState.FAILED,
        LifecycleState.CANCELLED,
        LifecycleState.INTERRUPTED,
    }
)

RETRYABLE_STATES: Final[frozenset[LifecycleState]] = frozenset(
    {
        LifecycleState.FAILED,
        LifecycleState.CANCELLED,
        LifecycleState.INTERRUPTED,
    }
)


@dataclass(frozen=True, slots=True)
class IllegalTransitionError(ValueError):
    """A lifecycle transition absent from the explicit transition table."""

    current: LifecycleState
    event: LifecycleEvent

    @override
    def __str__(self) -> str:
        return f"illegal transition {self.current.value} --{self.event.value}-->"


@dataclass(frozen=True, slots=True)
class StageOrderError(ValueError):
    """A transfer-stage sequence violated the fixed stage ordering contract."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid stage order: {self.reason}"


@dataclass(frozen=True, slots=True)
class RetryNotAllowedError(ValueError):
    """An attempt cannot seed a fresh linked queued attempt."""

    attempt_id: AttemptId
    state: LifecycleState

    @override
    def __str__(self) -> str:
        return (
            f"attempt {self.attempt_id} in state {self.state.value} cannot be retried"
        )


def transition(current: LifecycleState, event: LifecycleEvent) -> LifecycleState:
    """Apply the explicit lifecycle transition table to one attempt state.

    The complete legal table is documented by :data:`_TRANSITION_TABLE`;
    every other state/event combination raises a typed
    :class:`IllegalTransitionError`, so terminal successes cannot mutate and
    stray events fail loudly.
    """
    match _TRANSITION_TABLE.get((current, event)):
        case LifecycleState() as target:
            return target
        case None:
            raise IllegalTransitionError(current=current, event=event)


def is_terminal(state: LifecycleState) -> bool:
    """Return whether the state is terminal and can no longer mutate."""
    return state in TERMINAL_STATES


def is_retryable(state: LifecycleState) -> bool:
    """Return whether the state can seed a fresh linked queued attempt."""
    return state in RETRYABLE_STATES


@dataclass(frozen=True, slots=True)
class AttemptRef:
    """The task and attempt identifiers of one worker execution."""

    task_id: TaskId
    attempt_id: AttemptId


@dataclass(frozen=True, slots=True)
class NewAttempt:
    """A fresh queued attempt linked to the original terminal attempt."""

    task_id: TaskId
    attempt_id: AttemptId
    linked_from: AttemptId
    state: LifecycleState = LifecycleState.QUEUED


def retry_attempt(
    original: AttemptRef,
    original_state: LifecycleState,
    new_attempt_id: AttemptId,
) -> NewAttempt:
    """Create the only path back to ``queued``: a new attempt linked to ``original``.

    ``succeeded`` never retries and in-flight states cannot be retried while
    a worker is active; every other terminal state produces a queued attempt
    that records ``linked_from`` for history and recovery.
    """
    match original_state:
        case LifecycleState.SUCCEEDED:
            raise RetryNotAllowedError(
                attempt_id=original.attempt_id, state=original_state
            )
        case LifecycleState.QUEUED | LifecycleState.RUNNING | LifecycleState.CANCELLING:
            raise RetryNotAllowedError(
                attempt_id=original.attempt_id, state=original_state
            )
        case (
            LifecycleState.FAILED
            | LifecycleState.CANCELLED
            | LifecycleState.INTERRUPTED
        ):
            return NewAttempt(
                task_id=original.task_id,
                attempt_id=new_attempt_id,
                linked_from=original.attempt_id,
            )


def validate_stage_order(stages: Sequence[TransferStage]) -> tuple[TransferStage, ...]:
    """Validate a reported stage sequence against the fixed stage ordering.

    Kind-specific omission is allowed (a cached single-file download might
    report only ``preflight, transfer, finalize``), but a later stage may
    never precede an earlier one and no stage may repeat.
    """
    last_index = -1
    for stage in stages:
        index = _STAGE_POSITION[stage]
        if index <= last_index:
            raise StageOrderError(
                reason=f"{stage.value} is out of the fixed stage order"
            )
        last_index = index
    return tuple(stages)
