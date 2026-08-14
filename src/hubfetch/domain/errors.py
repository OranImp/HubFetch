"""Typed error categories with stable message IDs and one recovery action.

Every failing transfer maps to exactly one :class:`ErrorCategory`. Each
category is a distinct typed exception carrying an immutable :class:`ErrorSpec`
that fixes the stable message ID, the failed :class:`TransferStage` (reused
from :mod:`hubfetch.domain.lifecycle`), a severity, and exactly one executable
recovery action. Diagnostic detail is kept in a separate field and is only
readable through :meth:`HubFetchError.sanitized_detail`, which reuses the
Todo 5 redactor; it never enters ``str()`` so raw exception text or secrets
cannot reach the UI.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum, unique
from typing import TYPE_CHECKING, ClassVar, Final, NewType, override

from .lifecycle import TransferStage

if TYPE_CHECKING:
    from hubfetch.security.redaction import Redactor

MessageId = NewType("MessageId", str)
"""A stable, machine-consumed catalog key; never translated or reworded."""


@unique
class ErrorCategory(StrEnum):
    """Closed set of error categories every typed failure belongs to."""

    VALIDATION = "validation"
    AUTHENTICATION = "authentication"
    GATED_ACCESS = "gated_access"
    NOT_FOUND = "not_found"
    NETWORK = "network"
    DISK = "disk"
    DEPENDENCY = "dependency"
    PROCESS_CONTAINMENT = "process_containment"
    CANCELLATION = "cancellation"
    PERSISTENCE = "persistence"
    INTERNAL = "internal"


@unique
class Severity(StrEnum):
    """Closed severity levels surfaced to the user for an error."""

    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


@unique
class RecoveryAction(StrEnum):
    """Closed set of one executable recovery action per error category."""

    RETRY = "retry"
    REAUTHENTICATE = "reauthenticate"
    REQUEST_ACCESS = "request_access"
    CHECK_REVISION = "check_revision"
    CHECK_NETWORK = "check_network"
    FREE_SPACE = "free_space"
    INSTALL_DEPENDENCY = "install_dependency"
    RESTART_TASK = "restart_task"
    RESUME = "resume"
    RETRY_PERSISTENCE = "retry_persistence"
    REPORT_BUG = "report_bug"


@dataclass(frozen=True, slots=True)
class ErrorSpec:
    """Immutable mapping of one category to its localization contract."""

    category: ErrorCategory
    message_id: MessageId
    stage: TransferStage
    severity: Severity
    recovery_action: RecoveryAction


class HubFetchError(Exception):
    """Base class for every typed HubFetch error.

    Carries an immutable :class:`ErrorSpec` plus a separate, sanitizable
    ``detail`` string. ``str()`` renders only the stable message ID so raw
    exception text or secrets never reach the UI; the detail must be read
    through :meth:`sanitized_detail` with a Todo 5 :class:`Redactor`.
    """

    __slots__: Final = ("detail", "spec")

    spec: ErrorSpec
    detail: str | None

    def __init__(self, spec: ErrorSpec, *, detail: str | None = None) -> None:
        """Attach the immutable spec and separate sanitizable detail."""
        self.spec = spec
        self.detail = detail
        super().__init__(str(spec.message_id))

    @override
    def __str__(self) -> str:
        return str(self.spec.message_id)

    @property
    def message_id(self) -> MessageId:
        """Return the stable catalog key for this error."""
        return self.spec.message_id

    @property
    def stage(self) -> TransferStage:
        """Return the failed transfer stage reported to the user."""
        return self.spec.stage

    @property
    def severity(self) -> Severity:
        """Return the severity surfaced for this error."""
        return self.spec.severity

    @property
    def recovery_action(self) -> RecoveryAction:
        """Return the one executable recovery action for this error."""
        return self.spec.recovery_action

    def sanitized_detail(self, redactor: Redactor) -> str | None:
        """Return the separate diagnostic detail with secrets redacted.

        The raw detail never appears in ``str()``; callers that persist or
        display diagnostics must pass through this method so Todo 5 redaction
        applies before the value crosses a serialization boundary.
        """
        if self.detail is None:
            return None
        return redactor.redact_text(self.detail)


class ValidationError(HubFetchError):
    """A user-supplied value failed the validation boundary."""

    SPEC: ClassVar[ErrorSpec] = ErrorSpec(
        category=ErrorCategory.VALIDATION,
        message_id=MessageId("error.validation"),
        stage=TransferStage.PREFLIGHT,
        severity=Severity.WARNING,
        recovery_action=RecoveryAction.RETRY,
    )


class AuthenticationError(HubFetchError):
    """Authentication failed or a credential was rejected."""

    SPEC: ClassVar[ErrorSpec] = ErrorSpec(
        category=ErrorCategory.AUTHENTICATION,
        message_id=MessageId("error.authentication"),
        stage=TransferStage.AUTHENTICATE,
        severity=Severity.ERROR,
        recovery_action=RecoveryAction.REAUTHENTICATE,
    )


class GatedAccessError(HubFetchError):
    """The target repository is gated and access is not granted."""

    SPEC: ClassVar[ErrorSpec] = ErrorSpec(
        category=ErrorCategory.GATED_ACCESS,
        message_id=MessageId("error.gated_access"),
        stage=TransferStage.AUTHENTICATE,
        severity=Severity.ERROR,
        recovery_action=RecoveryAction.REQUEST_ACCESS,
    )


class NotFoundError(HubFetchError):
    """A repository or revision could not be resolved."""

    SPEC: ClassVar[ErrorSpec] = ErrorSpec(
        category=ErrorCategory.NOT_FOUND,
        message_id=MessageId("error.not_found"),
        stage=TransferStage.RESOLVE,
        severity=Severity.WARNING,
        recovery_action=RecoveryAction.CHECK_REVISION,
    )


class NetworkError(HubFetchError):
    """A network, proxy, or TLS failure interrupted the transfer."""

    SPEC: ClassVar[ErrorSpec] = ErrorSpec(
        category=ErrorCategory.NETWORK,
        message_id=MessageId("error.network"),
        stage=TransferStage.TRANSFER,
        severity=Severity.ERROR,
        recovery_action=RecoveryAction.CHECK_NETWORK,
    )


class DiskError(HubFetchError):
    """A disk, path, or destination-conflict problem blocked materialization."""

    SPEC: ClassVar[ErrorSpec] = ErrorSpec(
        category=ErrorCategory.DISK,
        message_id=MessageId("error.disk"),
        stage=TransferStage.MATERIALIZE,
        severity=Severity.ERROR,
        recovery_action=RecoveryAction.FREE_SPACE,
    )


class DependencyError(HubFetchError):
    """A required runtime dependency is missing or unusable."""

    SPEC: ClassVar[ErrorSpec] = ErrorSpec(
        category=ErrorCategory.DEPENDENCY,
        message_id=MessageId("error.dependency"),
        stage=TransferStage.PREFLIGHT,
        severity=Severity.ERROR,
        recovery_action=RecoveryAction.INSTALL_DEPENDENCY,
    )


class ProcessContainmentError(HubFetchError):
    """The worker process could not be isolated inside its Job Object."""

    SPEC: ClassVar[ErrorSpec] = ErrorSpec(
        category=ErrorCategory.PROCESS_CONTAINMENT,
        message_id=MessageId("error.process_containment"),
        stage=TransferStage.PREFLIGHT,
        severity=Severity.CRITICAL,
        recovery_action=RecoveryAction.RESTART_TASK,
    )


class CancellationError(HubFetchError):
    """The attempt was cancelled before reaching a terminal success."""

    SPEC: ClassVar[ErrorSpec] = ErrorSpec(
        category=ErrorCategory.CANCELLATION,
        message_id=MessageId("error.cancellation"),
        stage=TransferStage.TRANSFER,
        severity=Severity.INFO,
        recovery_action=RecoveryAction.RESUME,
    )


class PersistenceError(HubFetchError):
    """A persisted write failed and the store could not be updated."""

    SPEC: ClassVar[ErrorSpec] = ErrorSpec(
        category=ErrorCategory.PERSISTENCE,
        message_id=MessageId("error.persistence"),
        stage=TransferStage.FINALIZE,
        severity=Severity.ERROR,
        recovery_action=RecoveryAction.RETRY_PERSISTENCE,
    )


class InternalError(HubFetchError):
    """An unexpected boundary failure occurred inside the application."""

    SPEC: ClassVar[ErrorSpec] = ErrorSpec(
        category=ErrorCategory.INTERNAL,
        message_id=MessageId("error.internal"),
        stage=TransferStage.FINALIZE,
        severity=Severity.CRITICAL,
        recovery_action=RecoveryAction.REPORT_BUG,
    )


CATEGORY_SPECS: Final[dict[ErrorCategory, ErrorSpec]] = {
    ErrorCategory.VALIDATION: ValidationError.SPEC,
    ErrorCategory.AUTHENTICATION: AuthenticationError.SPEC,
    ErrorCategory.GATED_ACCESS: GatedAccessError.SPEC,
    ErrorCategory.NOT_FOUND: NotFoundError.SPEC,
    ErrorCategory.NETWORK: NetworkError.SPEC,
    ErrorCategory.DISK: DiskError.SPEC,
    ErrorCategory.DEPENDENCY: DependencyError.SPEC,
    ErrorCategory.PROCESS_CONTAINMENT: ProcessContainmentError.SPEC,
    ErrorCategory.CANCELLATION: CancellationError.SPEC,
    ErrorCategory.PERSISTENCE: PersistenceError.SPEC,
    ErrorCategory.INTERNAL: InternalError.SPEC,
}

ALL_SPECS: Final[tuple[ErrorSpec, ...]] = tuple(CATEGORY_SPECS.values())

_ERROR_TYPES: Final[dict[ErrorCategory, type[HubFetchError]]] = {
    ErrorCategory.VALIDATION: ValidationError,
    ErrorCategory.AUTHENTICATION: AuthenticationError,
    ErrorCategory.GATED_ACCESS: GatedAccessError,
    ErrorCategory.NOT_FOUND: NotFoundError,
    ErrorCategory.NETWORK: NetworkError,
    ErrorCategory.DISK: DiskError,
    ErrorCategory.DEPENDENCY: DependencyError,
    ErrorCategory.PROCESS_CONTAINMENT: ProcessContainmentError,
    ErrorCategory.CANCELLATION: CancellationError,
    ErrorCategory.PERSISTENCE: PersistenceError,
    ErrorCategory.INTERNAL: InternalError,
}


def error_for(category: ErrorCategory, *, detail: str | None = None) -> HubFetchError:
    """Construct the distinct typed exception for one error category."""
    error_type = _ERROR_TYPES[category]
    return error_type(CATEGORY_SPECS[category], detail=detail)


def required_message_ids() -> tuple[MessageId, ...]:
    """Return every catalog key the typed errors require in both locales.

    Each category contributes its stable error message ID, and every recovery
    action contributes a ``recovery.<action>`` label key, so the coverage
    checker can prove both locales are complete for the whole contract.
    """
    error_ids = tuple(spec.message_id for spec in ALL_SPECS)
    recovery_ids = tuple(
        MessageId(f"recovery.{action.value}") for action in RecoveryAction
    )
    return error_ids + recovery_ids
