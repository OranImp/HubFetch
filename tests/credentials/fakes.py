"""In-memory keyring doubles for the credential store tests."""

from __future__ import annotations

from typing import Final, override

from keyring.backend import KeyringBackend
from keyring.backends.Windows import WinVaultKeyring
from keyring.errors import KeyringError, PasswordDeleteError


class FakeBackend(KeyringBackend):
    """Keyring double that records every call and stores nothing."""

    def __init__(self) -> None:
        super().__init__()
        self.set_calls: list[tuple[str, str, str]] = []
        self.get_calls: list[tuple[str, str]] = []
        self.delete_calls: list[tuple[str, str]] = []

    @override
    def get_password(self, service: str, username: str) -> str | None:
        self.get_calls.append((service, username))
        return None

    @override
    def set_password(self, service: str, username: str, password: str) -> None:
        self.set_calls.append((service, username, password))

    @override
    def delete_password(self, service: str, username: str) -> None:
        self.delete_calls.append((service, username))
        raise PasswordDeleteError(service)


class MemoryWindowsVault(WinVaultKeyring):
    """In-memory stand-in for the Windows Credential Manager backend."""

    def __init__(self) -> None:
        super().__init__()
        self.values: dict[tuple[str, str], str] = {}
        self.set_calls: list[tuple[str, str, str]] = []

    @override
    def get_password(self, service: str, username: str) -> str | None:
        return self.values.get((service, username))

    @override
    def set_password(self, service: str, username: str, password: str) -> None:
        self.set_calls.append((service, username, password))
        self.values[(service, username)] = password

    @override
    def delete_password(self, service: str, username: str) -> None:
        if (service, username) not in self.values:
            raise PasswordDeleteError(service)
        del self.values[(service, username)]


class FailingWindowsVault(WinVaultKeyring):
    """Windows double whose every operation raises a KeyringError."""

    _VAULT_GET_FAILURE: Final = "vault unreachable"
    _VAULT_SET_FAILURE: Final = "vault unwritable"
    _VAULT_DELETE_FAILURE: Final = "vault undeletable"

    @override
    def get_password(self, service: str, username: str) -> str | None:
        raise KeyringError(self._VAULT_GET_FAILURE)

    @override
    def set_password(self, service: str, username: str, password: str) -> None:
        raise KeyringError(self._VAULT_SET_FAILURE)

    @override
    def delete_password(self, service: str, username: str) -> None:
        raise KeyringError(self._VAULT_DELETE_FAILURE)


class NullLikeBackend(FakeBackend):
    """Double reporting the keyring null-backend module identity."""

    __module__ = "keyring.backends.null"


class FailLikeBackend(FakeBackend):
    """Double reporting the keyring fail-backend module identity."""

    __module__ = "keyring.backends.fail"


class ChainerLikeBackend(FakeBackend):
    """Double reporting the keyring chainer-backend module identity."""

    __module__ = "keyring.backends.chainer"


class AltPlaintextBackend(FakeBackend):
    """Double reporting the untrusted keyrings.alt plaintext package."""

    __module__ = "keyrings.alt.backends.plaintext"


class PlaintextNamedBackend(FakeBackend):
    """Double whose class name advertises plaintext storage."""

    __module__ = "some.vendor.module"
