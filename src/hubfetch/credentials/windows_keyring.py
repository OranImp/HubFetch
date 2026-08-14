"""Windows Credential Manager adapter for the HubFetch credential store.

The adapter is fail-closed by construction: construction verifies the active
keyring backend is the Windows Credential Manager implementation and rejects
null, fail, plaintext, chainer, and ``keyrings.alt`` backends before any
credential operation can be attempted.
"""

from __future__ import annotations

from contextlib import contextmanager
from operator import methodcaller
from typing import TYPE_CHECKING, Final, override

import keyring
from keyring.backends.chainer import ChainerBackend
from keyring.backends.Windows import WinVaultKeyring
from keyring.errors import KeyringError, PasswordDeleteError

from hubfetch.config.identity import APP_IDENTITY

from .models import BackendIdentity, generate_credential_alias
from .port import (
    CredentialBackendError,
    CredentialBackendRejectedError,
    CredentialNotFoundError,
    CredentialStore,
)

if TYPE_CHECKING:
    from collections.abc import Generator

    from keyring.backend import KeyringBackend

    from hubfetch.security.redaction import SecretRegistry

    from .models import CredentialAlias

_UNTRUSTED_BACKEND_MODULES: Final = frozenset(
    {"keyring.backends.chainer", "keyring.backends.fail", "keyring.backends.null"}
)
"""Backends that never store a durable credential, rejected on sight."""


def backend_rejection_reason(backend: KeyringBackend) -> str | None:
    """Return why a backend is rejected, or None when it is the accepted one."""
    if isinstance(backend, WinVaultKeyring):
        return None
    module = type(backend).__module__
    class_name = type(backend).__name__
    qualified = f"{module}.{class_name}"
    if isinstance(backend, ChainerBackend) or module == "keyring.backends.chainer":
        return f"chainer backend {qualified} may chain to plaintext storage"
    if module.startswith("keyrings.alt"):
        return f"untrusted keyrings.alt backend {qualified}"
    if module in _UNTRUSTED_BACKEND_MODULES:
        return f"{module} backend {qualified} stores no durable credential"
    if "plaintext" in module.casefold() or "plaintext" in class_name.casefold():
        return f"plaintext backend {qualified} stores tokens in clear text"
    return f"backend {qualified} is not the Windows Credential Manager"


def verify_keyring_backend(backend: KeyringBackend) -> KeyringBackend:
    """Fail closed unless the active backend is the Windows Credential Manager."""
    reason = backend_rejection_reason(backend)
    if reason is not None:
        raise CredentialBackendRejectedError(reason=reason)
    return backend


def describe_backend(backend: KeyringBackend) -> BackendIdentity:
    """Return the module and class identity of one keyring backend."""
    return BackendIdentity(
        module=type(backend).__module__,
        class_name=type(backend).__name__,
    )


class WindowsCredentialManagerStore(CredentialStore):
    """Store HubFetch-only tokens in Windows Credential Manager through keyring."""

    __slots__: Final = ("_backend", "_identity", "_service")

    _backend: KeyringBackend
    _identity: BackendIdentity
    _service: str

    def __init__(
        self,
        *,
        backend: KeyringBackend | None = None,
        service: str = APP_IDENTITY.credentials_service,
    ) -> None:
        """Verify the backend at startup and lock the credential service."""
        selected = backend if backend is not None else keyring.get_keyring()
        self._backend = verify_keyring_backend(selected)
        self._identity = describe_backend(self._backend)
        self._service = service

    @override
    def create(self, *, token: str) -> CredentialAlias:
        """Store a new token and return its fresh opaque alias."""
        alias = generate_credential_alias()
        self._write_token(alias, token)
        return alias

    @override
    def replace(self, alias: CredentialAlias, *, token: str) -> None:
        """Overwrite the token behind an existing alias."""
        self._require_alias(alias)
        self._write_token(alias, token)

    @override
    def resolve(self, alias: CredentialAlias) -> str:
        """Return the stored token for one alias."""
        token = self._read_token(alias)
        if token is None:
            raise CredentialNotFoundError(reason=f"alias {alias} has no stored token")
        return token

    @override
    def delete(self, alias: CredentialAlias) -> None:
        """Remove the stored token behind one alias."""
        try:
            self._backend.delete_password(self._service, alias)
        except PasswordDeleteError as error:
            raise CredentialNotFoundError(
                reason=f"alias {alias} has no stored token"
            ) from error
        except KeyringError as error:
            reason = f"delete_password failed for alias {alias}: {error}"
            raise CredentialBackendError(reason=reason) from error

    @property
    @override
    def backend_identity(self) -> BackendIdentity:
        """Return the verified backend identity for diagnostics."""
        return self._identity

    @contextmanager
    def resolve_redacted(
        self, alias: CredentialAlias, *, registry: SecretRegistry
    ) -> Generator[str, None, None]:
        """Resolve a token and keep it registered with the redactor while active.

        The token is registered only for the duration of the ``with`` block so
        diagnostics produced during the authenticated call are redacted and the
        reference is discarded immediately afterwards.
        """
        token = self.resolve(alias)
        with registry.bound(token):
            yield token

    def _write_token(self, alias: CredentialAlias, token: str) -> None:
        try:
            self._set_backend_password(alias, token)
        except KeyringError as error:
            reason = f"set_password failed for alias {alias}: {error}"
            raise CredentialBackendError(reason=reason) from error

    def _set_backend_password(self, alias: CredentialAlias, token: str) -> None:
        """Write through keyring's set_password despite its untyped wrapper.

        keyring's metaclass rewraps set_password with functools.wraps, so
        basedpyright models the member as ``_Wrapped`` with Unknown parameters
        and rejects a direct call in ``all`` mode; dispatch through the runtime
        method instead, keeping the store's own signatures fully typed.
        """
        methodcaller("set_password", self._service, alias, token)(self._backend)

    def _read_token(self, alias: CredentialAlias) -> str | None:
        try:
            return self._backend.get_password(self._service, alias)
        except KeyringError as error:
            reason = f"get_password failed for alias {alias}: {error}"
            raise CredentialBackendError(reason=reason) from error

    def _require_alias(self, alias: CredentialAlias) -> None:
        if self._read_token(alias) is None:
            raise CredentialNotFoundError(reason=f"alias {alias} has no stored token")
