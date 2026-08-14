"""Normalize pinned Hub exception classes into Todo 6 typed errors.

Every exception raised by ``huggingface_hub`` 1.27.0 at the adapter boundary
is mapped here into exactly one :class:`HubFetchError` from
:mod:`hubfetch.domain.errors` so the UI sees a stable, localized recovery
descriptor instead of library exception text. The mapping distinguishes the
cases the plan names: public/private access, gated repos, missing repos,
missing revisions, offline mode, rate limits, proxy/TLS/connect failures, and
generic network errors.

The library deliberately wraps network causes inside ``LocalEntryNotFound``
fallback errors, so a network-cause chain walk runs before the top-level
dispatch; without it an offline or proxy failure would be mislabeled as a
missing file.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import httpx
from huggingface_hub import errors as hub_errors

from hubfetch.domain.errors import (
    ErrorCategory,
    HubFetchError,
    error_for,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

HUB_ERROR_TYPES: Final[tuple[type[BaseException], ...]] = (
    hub_errors.OfflineModeIsEnabled,
    hub_errors.GatedRepoError,
    hub_errors.RepositoryNotFoundError,
    hub_errors.RevisionNotFoundError,
    hub_errors.RemoteEntryNotFoundError,
    hub_errors.EntryNotFoundError,
    hub_errors.LocalEntryNotFoundError,
    hub_errors.DisabledRepoError,
    hub_errors.DryRunError,
    hub_errors.HFValidationError,
    hub_errors.LocalTokenNotFoundError,
    hub_errors.HfHubHTTPError,
    httpx.TransportError,
    httpx.TimeoutException,
)
"""Every Hub boundary exception the adapter may catch and map."""

_NETWORK_CAUSES: Final[tuple[type[BaseException], ...]] = (
    httpx.TransportError,
    httpx.TimeoutException,
    hub_errors.OfflineModeIsEnabled,
)
"""Exception types whose presence anywhere in a cause chain means network."""


def _detail(exc: BaseException) -> str:
    """Build a short, secret-free diagnostic label for one hub exception."""
    name = type(exc).__name__
    if isinstance(exc, hub_errors.HfHubHTTPError):
        status = exc.response.status_code
        return f"hub http error {status} ({name})"
    if isinstance(exc, httpx.HTTPError):
        return f"hub network error ({name})"
    return f"hub error ({name})"


def _network_cause(exc: BaseException) -> BaseException | None:
    """Return the first network-layer cause found in an exception chain."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, _NETWORK_CAUSES):
            return current
        current = current.__cause__ or current.__context__
    return None


def _mapped(category: ErrorCategory, exc: BaseException) -> HubFetchError:
    """Build the typed error for one category with a secret-free detail."""
    return error_for(category, detail=_detail(exc))


def _map_http_error(error: hub_errors.HfHubHTTPError) -> HubFetchError:
    """Map a bare HTTP error by status when no specific subclass matched."""
    status = error.response.status_code
    match status:
        case 400:
            return _mapped(ErrorCategory.VALIDATION, error)
        case 401 | 403:
            return _mapped(ErrorCategory.AUTHENTICATION, error)
        case 404:
            return _mapped(ErrorCategory.NOT_FOUND, error)
        case 429:
            return _mapped(ErrorCategory.NETWORK, error)
        case _:
            return _mapped(ErrorCategory.NETWORK, error)


def normalize_hub_error(  # noqa: PLR0911 - exhaustive closed-set dispatch
    exc: BaseException, *, authenticated: bool
) -> HubFetchError:
    """Map one Hub boundary exception to its Todo 6 typed recovery descriptor.

    Args:
        exc: An exception raised inside a pinned Hub call.
        authenticated: Whether a token was sent with the request. A
            ``RepositoryNotFoundError`` while anonymous is most likely a
            private repo, so it maps to reauthentication; the same error with
            a token means the repo really is missing or the account lacks
            access, so it maps to checking the revision.
    """
    cause = _network_cause(exc)
    if cause is not None:
        return _mapped(ErrorCategory.NETWORK, cause)
    match exc:
        case hub_errors.GatedRepoError():
            return _mapped(ErrorCategory.GATED_ACCESS, exc)
        case hub_errors.RepositoryNotFoundError():
            category = (
                ErrorCategory.NOT_FOUND
                if authenticated
                else ErrorCategory.AUTHENTICATION
            )
            return _mapped(category, exc)
        case hub_errors.RevisionNotFoundError():
            return _mapped(ErrorCategory.NOT_FOUND, exc)
        case (
            hub_errors.RemoteEntryNotFoundError()
            | hub_errors.EntryNotFoundError()
            | hub_errors.LocalEntryNotFoundError()
            | hub_errors.DisabledRepoError()
        ):
            return _mapped(ErrorCategory.NOT_FOUND, exc)
        case hub_errors.DryRunError():
            return _mapped(ErrorCategory.NETWORK, exc)
        case hub_errors.HFValidationError():
            return _mapped(ErrorCategory.VALIDATION, exc)
        case hub_errors.LocalTokenNotFoundError():
            return _mapped(ErrorCategory.AUTHENTICATION, exc)
        case hub_errors.HfHubHTTPError() as http_error:
            return _map_http_error(http_error)
        case _:
            message = f"unsupported hub exception type: {type(exc).__name__}"
            raise TypeError(message) from exc


def expected_hub_error_types() -> Sequence[type[BaseException]]:
    """Return the pinned boundary exception types for contract tests."""
    return HUB_ERROR_TYPES
