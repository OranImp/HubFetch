"""Tests for the typed, localized error category contracts.

Given/When/Then structure follows the plan: every error category carries a
stable message ID, a failed ``TransferStage``, a severity, and exactly one
executable recovery action; diagnostic detail stays separate and sanitized.
"""

from __future__ import annotations

import pytest

from hubfetch.domain.errors import (
    ALL_SPECS,
    CATEGORY_SPECS,
    AuthenticationError,
    CancellationError,
    DependencyError,
    DiskError,
    ErrorCategory,
    GatedAccessError,
    HubFetchError,
    InternalError,
    NetworkError,
    NotFoundError,
    PersistenceError,
    ProcessContainmentError,
    RecoveryAction,
    Severity,
    ValidationError,
    error_for,
    required_message_ids,
)
from hubfetch.domain.lifecycle import TransferStage
from hubfetch.security.redaction import Redactor, SecretRegistry

VALID_STAGES: frozenset[TransferStage] = frozenset(TransferStage)
VALID_SEVERITIES: frozenset[Severity] = frozenset(Severity)
VALID_ACTIONS: frozenset[RecoveryAction] = frozenset(RecoveryAction)


def test_each_category_has_a_distinct_exception_type() -> None:
    """Given every category, error_for returns a distinct typed exception."""
    seen: set[type[HubFetchError]] = set()

    for category in ErrorCategory:
        error = error_for(category)

        assert isinstance(error, HubFetchError)
        assert type(error) not in seen
        seen.add(type(error))


def test_every_spec_has_valid_stage_severity_and_recovery() -> None:
    """Given every spec, its metadata is a closed enum member."""
    for spec in ALL_SPECS:
        assert spec.stage in VALID_STAGES
        assert spec.severity in VALID_SEVERITIES
        assert spec.recovery_action in VALID_ACTIONS


def test_error_exposes_typed_metadata_matching_its_spec() -> None:
    """Given a constructed error, exposed metadata equals the category spec."""
    error = error_for(ErrorCategory.AUTHENTICATION, detail="bad token")

    spec = CATEGORY_SPECS[ErrorCategory.AUTHENTICATION]
    assert error.spec is spec
    assert error.message_id == spec.message_id
    assert error.stage == TransferStage.AUTHENTICATE
    assert error.severity == Severity.ERROR
    assert error.recovery_action == RecoveryAction.REAUTHENTICATE


def test_str_returns_stable_message_id_never_detail(hf_test_secret: str) -> None:
    """Given a secret-bearing detail, str() exposes only the stable message ID."""
    error = error_for(
        ErrorCategory.NETWORK, detail=f"token={hf_test_secret} leaked in a header"
    )

    assert str(error) == error.message_id
    assert hf_test_secret not in str(error)


def test_detail_is_sanitized_separately_by_redactor(hf_test_secret: str) -> None:
    """Given a registered secret inside detail, sanitized_detail redacts it."""
    registry = SecretRegistry()
    registry.register(hf_test_secret)
    redactor = Redactor(registry)
    error = error_for(
        ErrorCategory.NETWORK,
        detail=f"request failed for {hf_test_secret} at https://user:{hf_test_secret}@hub.example",
    )

    sanitized = error.sanitized_detail(redactor)

    assert sanitized is not None
    assert hf_test_secret not in sanitized
    assert "[REDACTED]" in sanitized
    assert "hub.example" in sanitized
    assert (
        error.detail
        == f"request failed for {hf_test_secret} at https://user:{hf_test_secret}@hub.example"
    )


def test_recovery_action_is_single_and_stable() -> None:
    """Given every spec, exactly one executable recovery action is declared."""
    for spec in ALL_SPECS:
        assert isinstance(spec.recovery_action, RecoveryAction)
        assert spec.recovery_action.value


def test_required_message_ids_are_stable_unique_and_non_empty() -> None:
    """Given the registry, required IDs are unique and cover errors plus actions."""
    ids = required_message_ids()

    assert len(set(ids)) == len(ids)
    assert len(ids) >= 2 * len(ErrorCategory)
    for identifier in ids:
        assert identifier
        assert identifier.startswith(("error.", "recovery."))


def test_typed_error_can_be_caught_by_its_concrete_class() -> None:
    """Given a network error instance, its concrete type is catchable directly."""
    assert isinstance(error_for(ErrorCategory.NETWORK), NetworkError)
    assert not isinstance(error_for(ErrorCategory.NETWORK), ValidationError)
    assert isinstance(error_for(ErrorCategory.CANCELLATION), CancellationError)
    assert isinstance(error_for(ErrorCategory.DISK), DiskError)
    assert isinstance(error_for(ErrorCategory.DEPENDENCY), DependencyError)
    assert isinstance(error_for(ErrorCategory.GATED_ACCESS), GatedAccessError)
    assert isinstance(error_for(ErrorCategory.INTERNAL), InternalError)
    assert isinstance(error_for(ErrorCategory.NOT_FOUND), NotFoundError)
    assert isinstance(error_for(ErrorCategory.PERSISTENCE), PersistenceError)
    assert isinstance(
        error_for(ErrorCategory.PROCESS_CONTAINMENT), ProcessContainmentError
    )
    assert isinstance(error_for(ErrorCategory.VALIDATION), ValidationError)
    assert isinstance(error_for(ErrorCategory.AUTHENTICATION), AuthenticationError)


def test_every_concrete_class_is_a_hubfetch_error() -> None:
    """Given every concrete class, all instances share the typed base."""
    for category in ErrorCategory:
        assert isinstance(error_for(category), HubFetchError)


@pytest.mark.parametrize(
    ("category", "message_id_prefix"),
    [
        (ErrorCategory.VALIDATION, "error.validation"),
        (ErrorCategory.AUTHENTICATION, "error.authentication"),
        (ErrorCategory.GATED_ACCESS, "error.gated_access"),
        (ErrorCategory.NOT_FOUND, "error.not_found"),
        (ErrorCategory.NETWORK, "error.network"),
        (ErrorCategory.DISK, "error.disk"),
        (ErrorCategory.DEPENDENCY, "error.dependency"),
        (ErrorCategory.PROCESS_CONTAINMENT, "error.process_containment"),
        (ErrorCategory.CANCELLATION, "error.cancellation"),
        (ErrorCategory.PERSISTENCE, "error.persistence"),
        (ErrorCategory.INTERNAL, "error.internal"),
    ],
)
def test_message_id_prefix_is_stable(
    category: ErrorCategory, message_id_prefix: str
) -> None:
    """Given each category, its message ID keeps the stable documented prefix."""
    spec = CATEGORY_SPECS[category]

    assert spec.message_id == message_id_prefix
