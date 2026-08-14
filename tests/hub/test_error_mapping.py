"""Tests for Hub exception normalization into Todo 6 typed errors.

Given/When/Then throughout: a pinned Hub exception is constructed, the
normalizer is called with the auth context, and the resulting typed error's
category, message ID, and recovery action are asserted. The network-cause
chain tests prove the library's ``LocalEntryNotFound`` fallback wrappers do
not mislabel offline, proxy, or TLS failures as missing files.
"""

from __future__ import annotations

import httpx
import pytest
from huggingface_hub import errors as hub_errors

from hubfetch.domain.errors import (
    ErrorCategory,
    HubFetchError,
    RecoveryAction,
)
from hubfetch.hub.error_mapping import HUB_ERROR_TYPES, normalize_hub_error

_ENDPOINT = "http://hub.test/api/models/org/repo"


def _response(
    status_code: int,
    *,
    error_code: str | None = None,
    error_message: str | None = None,
) -> httpx.Response:
    """Build a deterministic ``httpx.Response`` carrying Hub error headers."""
    headers: dict[str, str] = {}
    if error_code is not None:
        headers["X-Error-Code"] = error_code
    if error_message is not None:
        headers["X-Error-Message"] = error_message
    request = httpx.Request("GET", _ENDPOINT)
    return httpx.Response(status_code, request=request, headers=headers)


def _gated() -> hub_errors.GatedRepoError:
    return hub_errors.GatedRepoError(
        "gated", response=_response(403, error_code="GatedRepo")
    )


def _repo_not_found() -> hub_errors.RepositoryNotFoundError:
    return hub_errors.RepositoryNotFoundError(
        "not found", response=_response(404, error_code="RepoNotFound")
    )


def _revision_not_found() -> hub_errors.RevisionNotFoundError:
    return hub_errors.RevisionNotFoundError(
        "revision", response=_response(404, error_code="RevisionNotFound")
    )


def _http_error(status_code: int, **headers: str) -> hub_errors.HfHubHTTPError:
    return hub_errors.HfHubHTTPError("http", response=_response(status_code, **headers))


def _wrapped(*, cause: BaseException, wrapper: type[BaseException]) -> BaseException:
    """Build ``wrapper`` chained from ``cause`` like the library's fallbacks."""
    error = wrapper("fallback wrapper")
    error.__cause__ = cause
    return error


def _assert_error(
    error: HubFetchError,
    *,
    category: ErrorCategory,
    recovery: RecoveryAction,
) -> None:
    """Assert the distinct localized recovery descriptor of one mapping."""
    assert error.spec.category is category
    assert error.recovery_action is recovery
    assert str(error) == str(error.message_id)
    assert error.message_id == error.spec.message_id


class TestGatedMapping:
    """Given a gated-repo exception, when normalized, then it maps to request-access."""

    def test_gated_error_maps_to_gated_access(self) -> None:
        mapped = normalize_hub_error(_gated(), authenticated=False)
        _assert_error(
            mapped,
            category=ErrorCategory.GATED_ACCESS,
            recovery=RecoveryAction.REQUEST_ACCESS,
        )


class TestNotFoundMapping:
    """Given not-found/revision exceptions, then they map by auth context."""

    def test_repo_not_found_with_token_maps_to_check_revision(self) -> None:
        mapped = normalize_hub_error(_repo_not_found(), authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.NOT_FOUND,
            recovery=RecoveryAction.CHECK_REVISION,
        )

    def test_repo_not_found_anonymous_maps_to_reauthenticate(self) -> None:
        mapped = normalize_hub_error(_repo_not_found(), authenticated=False)
        _assert_error(
            mapped,
            category=ErrorCategory.AUTHENTICATION,
            recovery=RecoveryAction.REAUTHENTICATE,
        )

    def test_revision_not_found_maps_to_check_revision(self) -> None:
        mapped = normalize_hub_error(_revision_not_found(), authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.NOT_FOUND,
            recovery=RecoveryAction.CHECK_REVISION,
        )

    def test_disabled_repo_maps_to_check_revision(self) -> None:
        disabled = hub_errors.DisabledRepoError(
            "disabled",
            response=_response(
                403, error_message="Access to this resource is disabled."
            ),
        )
        mapped = normalize_hub_error(disabled, authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.NOT_FOUND,
            recovery=RecoveryAction.CHECK_REVISION,
        )

    def test_plain_local_entry_not_found_maps_to_not_found(self) -> None:
        local = hub_errors.LocalEntryNotFoundError("file missing from cache")
        mapped = normalize_hub_error(local, authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.NOT_FOUND,
            recovery=RecoveryAction.CHECK_REVISION,
        )


class TestAuthenticationMapping:
    """Given HTTP authentication errors, when normalized, they map to reauthenticate."""

    def test_http_401_maps_to_reauthenticate(self) -> None:
        mapped = normalize_hub_error(_http_error(401), authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.AUTHENTICATION,
            recovery=RecoveryAction.REAUTHENTICATE,
        )

    def test_http_403_maps_to_reauthenticate(self) -> None:
        mapped = normalize_hub_error(_http_error(403), authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.AUTHENTICATION,
            recovery=RecoveryAction.REAUTHENTICATE,
        )

    def test_missing_local_token_maps_to_reauthenticate(self) -> None:
        missing = hub_errors.LocalTokenNotFoundError("no token")
        mapped = normalize_hub_error(missing, authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.AUTHENTICATION,
            recovery=RecoveryAction.REAUTHENTICATE,
        )


class TestNetworkMapping:
    """Given offline/rate/proxy/TLS/connect errors, they map to check network."""

    def test_offline_mode_maps_to_check_network(self) -> None:
        mapped = normalize_hub_error(
            hub_errors.OfflineModeIsEnabled("offline"), authenticated=True
        )
        _assert_error(
            mapped,
            category=ErrorCategory.NETWORK,
            recovery=RecoveryAction.CHECK_NETWORK,
        )

    def test_http_429_maps_to_check_network(self) -> None:
        mapped = normalize_hub_error(_http_error(429), authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.NETWORK,
            recovery=RecoveryAction.CHECK_NETWORK,
        )

    def test_http_500_maps_to_check_network(self) -> None:
        mapped = normalize_hub_error(_http_error(500), authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.NETWORK,
            recovery=RecoveryAction.CHECK_NETWORK,
        )

    def test_connect_error_maps_to_check_network(self) -> None:
        mapped = normalize_hub_error(httpx.ConnectError("refused"), authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.NETWORK,
            recovery=RecoveryAction.CHECK_NETWORK,
        )

    def test_proxy_error_maps_to_check_network(self) -> None:
        mapped = normalize_hub_error(httpx.ProxyError("proxy down"), authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.NETWORK,
            recovery=RecoveryAction.CHECK_NETWORK,
        )


class TestWrappedNetworkCauses:
    """Given wrappers hiding a network cause, when normalized, the cause wins."""

    def test_local_entry_not_found_wrapping_connect_error_maps_to_network(self) -> None:
        wrapped = _wrapped(
            cause=httpx.ConnectError("tls failed"),
            wrapper=hub_errors.LocalEntryNotFoundError,
        )
        mapped = normalize_hub_error(wrapped, authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.NETWORK,
            recovery=RecoveryAction.CHECK_NETWORK,
        )

    def test_dry_run_error_wrapping_offline_maps_to_network(self) -> None:
        wrapped = _wrapped(
            cause=hub_errors.OfflineModeIsEnabled("offline"),
            wrapper=hub_errors.DryRunError,
        )
        mapped = normalize_hub_error(wrapped, authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.NETWORK,
            recovery=RecoveryAction.CHECK_NETWORK,
        )

    def test_dry_run_error_wrapping_proxy_maps_to_network(self) -> None:
        wrapped = _wrapped(
            cause=httpx.ProxyError("proxy down"), wrapper=hub_errors.DryRunError
        )
        mapped = normalize_hub_error(wrapped, authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.NETWORK,
            recovery=RecoveryAction.CHECK_NETWORK,
        )


class TestValidationAndInternalMapping:
    """Given bad-request/validation exceptions, they map to precise descriptors."""

    def test_http_400_maps_to_validation_retry(self) -> None:
        mapped = normalize_hub_error(_http_error(400), authenticated=True)
        _assert_error(
            mapped,
            category=ErrorCategory.VALIDATION,
            recovery=RecoveryAction.RETRY,
        )

    def test_hf_validation_error_maps_to_validation_retry(self) -> None:
        mapped = normalize_hub_error(
            hub_errors.HFValidationError("bad id"), authenticated=True
        )
        _assert_error(
            mapped,
            category=ErrorCategory.VALIDATION,
            recovery=RecoveryAction.RETRY,
        )

    def test_unknown_exception_is_rejected(self) -> None:
        with pytest.raises(TypeError):
            _ = normalize_hub_error(ValueError("not a hub error"), authenticated=True)


class TestBoundarySurface:
    """Given the pinned boundary surface, when read, then every class is included."""

    def test_hub_error_types_include_all_pinned_classes(self) -> None:
        names = {cls.__name__ for cls in HUB_ERROR_TYPES}
        assert {
            "GatedRepoError",
            "RepositoryNotFoundError",
            "RevisionNotFoundError",
        } <= names
        assert {"OfflineModeIsEnabled", "DryRunError", "HfHubHTTPError"} <= names
        assert {"TransportError", "TimeoutException"} <= names
