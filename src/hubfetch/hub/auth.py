"""Resolve a task's closed auth source into Hub token material.

The adapter owns Hub API calls; this module owns the auth boundary. A
manual-token source resolves its opaque alias through the Todo 8 credential
store inside the worker, while anonymous and shared-OAuth sources map to the
library's ``token`` contract (``False`` and ``True`` respectively). Every
resolution failure is normalized into a Todo 6 typed error here, so the
adapter constructor can fail closed before any authenticated request is made.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from hubfetch.credentials.port import (
    CredentialBackendError,
    CredentialBackendRejectedError,
    CredentialNotFoundError,
    CredentialStore,
)
from hubfetch.domain.errors import ErrorCategory, error_for
from hubfetch.domain.task_spec import AuthSource

if TYPE_CHECKING:
    from hubfetch.credentials.models import CredentialAlias

__all__ = ["ResolvedAuth", "resolve_auth"]


@dataclass(frozen=True, slots=True)
class ResolvedAuth:
    """Auth material handed to every Hub request, resolved before use."""

    token: str | bool
    authenticated: bool


def resolve_auth(
    source: AuthSource,
    *,
    alias: CredentialAlias | None,
    store: CredentialStore | None,
) -> ResolvedAuth:
    """Resolve the task auth source into token material before any request.

    Args:
        source: The closed authentication source for one task.
        alias: Opaque alias resolved through ``store`` for manual-token auth.
        store: Todo 8 store used to resolve a manual-token alias.

    Raises:
        A Todo 6 typed error when a manual-token alias cannot be resolved or
        the vault backend is unusable, before any authenticated request.
    """
    match source:
        case AuthSource.ANONYMOUS:
            return ResolvedAuth(token=False, authenticated=False)
        case AuthSource.SHARED_OAUTH:
            return ResolvedAuth(token=True, authenticated=True)
        case AuthSource.MANUAL_TOKEN:
            if alias is None or store is None:
                raise error_for(
                    ErrorCategory.VALIDATION,
                    detail="manual-token auth needs an alias and store",
                )
            token = _resolve_token(alias, store)
            return ResolvedAuth(token=token, authenticated=True)


def _resolve_token(alias: CredentialAlias, store: CredentialStore) -> str:
    """Resolve one app token inside the worker through the Todo 8 store."""
    try:
        return store.resolve(alias)
    except CredentialNotFoundError as error:
        raise error_for(
            ErrorCategory.AUTHENTICATION,
            detail="credential alias is not present in the vault",
        ) from error
    except (CredentialBackendError, CredentialBackendRejectedError) as error:
        raise error_for(
            ErrorCategory.DEPENDENCY,
            detail="credential backend is unavailable or rejected",
        ) from error
