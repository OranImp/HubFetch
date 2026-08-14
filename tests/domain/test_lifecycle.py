"""Tests for the explicit lifecycle, retry, and stage-ordering contracts."""

from __future__ import annotations

import pytest

from hubfetch.domain.ids import AttemptId, TaskId
from hubfetch.domain.lifecycle import (
    AttemptRef,
    IllegalTransitionError,
    LifecycleEvent,
    LifecycleState,
    NewAttempt,
    RetryNotAllowedError,
    StageOrderError,
    TransferStage,
    is_retryable,
    is_terminal,
    retry_attempt,
    transition,
    validate_stage_order,
)

LEGAL_TRANSITIONS: dict[tuple[LifecycleState, LifecycleEvent], LifecycleState] = {
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

ALL_STATES: tuple[LifecycleState, ...] = tuple(LifecycleState)
ALL_EVENTS: tuple[LifecycleEvent, ...] = tuple(LifecycleEvent)

RETRYABLE_STATES: tuple[LifecycleState, ...] = (
    LifecycleState.FAILED,
    LifecycleState.CANCELLED,
    LifecycleState.INTERRUPTED,
)


def test_every_legal_transition_reaches_expected_state() -> None:
    """Given every legal state/event pair, the transition table returns it."""
    for (state, event), expected in LEGAL_TRANSITIONS.items():
        result = transition(state, event)

        assert result == expected


def test_every_illegal_transition_raises_typed_error() -> None:
    """Given every pair absent from the table, transition raises typed error."""
    for state in ALL_STATES:
        for event in ALL_EVENTS:
            if (state, event) in LEGAL_TRANSITIONS:
                continue

            with pytest.raises(IllegalTransitionError) as caught:
                _ = transition(state, event)

            assert caught.value.current == state
            assert caught.value.event == event


def test_terminal_success_never_mutates() -> None:
    """Given a succeeded state, no event produces a state change."""
    for event in ALL_EVENTS:
        with pytest.raises(IllegalTransitionError):
            _ = transition(LifecycleState.SUCCEEDED, event)


def test_duplicate_transition_from_running_rejected() -> None:
    """Given a repeated succeeded event, the second call raises typed error."""
    assert transition(LifecycleState.RUNNING, LifecycleEvent.SUCCEEDED) == (
        LifecycleState.SUCCEEDED
    )

    with pytest.raises(IllegalTransitionError):
        _ = transition(LifecycleState.SUCCEEDED, LifecycleEvent.SUCCEEDED)


def test_retry_creates_linked_queued_attempt_for_each_retryable_state() -> None:
    """Given a retryable terminal state, retry produces a linked queued attempt."""
    original = AttemptRef(task_id=TaskId("task-1"), attempt_id=AttemptId("attempt-1"))

    for state in RETRYABLE_STATES:
        result = retry_attempt(original, state, AttemptId("attempt-2"))

        assert isinstance(result, NewAttempt)
        assert result.task_id == TaskId("task-1")
        assert result.attempt_id == AttemptId("attempt-2")
        assert result.linked_from == AttemptId("attempt-1")
        assert result.state == LifecycleState.QUEUED


def test_retry_rejects_succeeded_attempt() -> None:
    """Given a succeeded attempt, retry raises a typed not-allowed error."""
    original = AttemptRef(task_id=TaskId("task-1"), attempt_id=AttemptId("attempt-1"))

    with pytest.raises(RetryNotAllowedError) as caught:
        _ = retry_attempt(original, LifecycleState.SUCCEEDED, AttemptId("attempt-2"))

    assert caught.value.state == LifecycleState.SUCCEEDED


def test_retry_rejects_non_terminal_states() -> None:
    """Given an in-flight state, retry raises a typed not-allowed error."""
    original = AttemptRef(task_id=TaskId("task-1"), attempt_id=AttemptId("attempt-1"))

    for state in (
        LifecycleState.QUEUED,
        LifecycleState.RUNNING,
        LifecycleState.CANCELLING,
    ):
        with pytest.raises(RetryNotAllowedError):
            _ = retry_attempt(original, state, AttemptId("attempt-2"))


def test_terminal_and_retryable_predicates_match_state_kinds() -> None:
    """Given every state, terminal and retryable predicates classify correctly."""
    assert is_terminal(LifecycleState.SUCCEEDED)
    assert is_terminal(LifecycleState.FAILED)
    assert is_terminal(LifecycleState.CANCELLED)
    assert is_terminal(LifecycleState.INTERRUPTED)
    assert not is_terminal(LifecycleState.QUEUED)
    assert not is_terminal(LifecycleState.RUNNING)
    assert not is_terminal(LifecycleState.CANCELLING)

    for state in RETRYABLE_STATES:
        assert is_retryable(state)
    assert not is_retryable(LifecycleState.SUCCEEDED)
    assert not is_retryable(LifecycleState.QUEUED)


def test_full_stage_order_is_accepted() -> None:
    """Given the full stage sequence, the ordering validator accepts it."""
    stages = (
        TransferStage.PREFLIGHT,
        TransferStage.AUTHENTICATE,
        TransferStage.RESOLVE,
        TransferStage.TRANSFER,
        TransferStage.MATERIALIZE,
        TransferStage.FINALIZE,
    )

    result = validate_stage_order(stages)

    assert result == stages


def test_omitted_stage_order_is_accepted() -> None:
    """Given kind-specific omissions, the ordering validator accepts them."""
    stages = (
        TransferStage.PREFLIGHT,
        TransferStage.TRANSFER,
        TransferStage.FINALIZE,
    )

    result = validate_stage_order(stages)

    assert result == stages


def test_single_and_empty_stage_orders_are_accepted() -> None:
    """Given a single stage or no stages, the ordering validator accepts them."""
    assert validate_stage_order((TransferStage.TRANSFER,)) == (TransferStage.TRANSFER,)
    assert validate_stage_order(()) == ()


def test_reversed_stage_order_is_rejected() -> None:
    """Given a reversed sequence, the ordering validator raises typed error."""
    with pytest.raises(StageOrderError):
        _ = validate_stage_order((TransferStage.TRANSFER, TransferStage.PREFLIGHT))


def test_out_of_order_stage_sequence_is_rejected() -> None:
    """Given an authenticate-after-resolve sequence, ordering is rejected."""
    with pytest.raises(StageOrderError):
        _ = validate_stage_order((TransferStage.RESOLVE, TransferStage.AUTHENTICATE))


def test_duplicate_stage_sequence_is_rejected() -> None:
    """Given a repeated stage, the ordering validator raises typed error."""
    with pytest.raises(StageOrderError):
        _ = validate_stage_order((TransferStage.PREFLIGHT, TransferStage.PREFLIGHT))
