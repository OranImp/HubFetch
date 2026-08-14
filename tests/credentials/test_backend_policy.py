"""Tests for the fail-closed Windows Credential Manager backend policy."""

from __future__ import annotations

import pytest
from keyring.backends.chainer import ChainerBackend
from keyring.backends.fail import Keyring as FailKeyring
from keyring.backends.null import Keyring as NullKeyring
from keyring.backends.Windows import WinVaultKeyring

from hubfetch.credentials.models import BackendIdentity
from hubfetch.credentials.port import CredentialBackendRejectedError
from hubfetch.credentials.windows_keyring import (
    WindowsCredentialManagerStore,
    backend_rejection_reason,
    describe_backend,
    verify_keyring_backend,
)
from tests.credentials.fakes import (
    AltPlaintextBackend,
    ChainerLikeBackend,
    FailLikeBackend,
    FakeBackend,
    MemoryWindowsVault,
    NullLikeBackend,
    PlaintextNamedBackend,
)


def test_accepts_the_windows_credential_manager_backend() -> None:
    backend = MemoryWindowsVault()

    assert verify_keyring_backend(backend) is backend
    assert backend_rejection_reason(backend) is None


def test_accepts_the_real_windows_backend_class() -> None:
    backend = WinVaultKeyring()

    assert backend_rejection_reason(backend) is None


@pytest.mark.parametrize(
    "backend_type",
    [
        NullLikeBackend,
        FailLikeBackend,
        ChainerLikeBackend,
        AltPlaintextBackend,
        PlaintextNamedBackend,
    ],
)
def test_rejects_every_non_windows_backend_before_any_write(
    backend_type: type[FakeBackend],
) -> None:
    backend = backend_type()

    with pytest.raises(CredentialBackendRejectedError):
        _ = WindowsCredentialManagerStore(backend=backend)

    assert backend.set_calls == []
    assert backend.get_calls == []
    assert backend.delete_calls == []


def test_rejects_the_real_chainer_backend() -> None:
    with pytest.raises(CredentialBackendRejectedError):
        _ = WindowsCredentialManagerStore(backend=ChainerBackend())


def test_rejects_the_real_null_and_fail_backends() -> None:
    with pytest.raises(CredentialBackendRejectedError):
        _ = WindowsCredentialManagerStore(backend=NullKeyring())
    with pytest.raises(CredentialBackendRejectedError):
        _ = WindowsCredentialManagerStore(backend=FailKeyring())


def test_alt_plaintext_reason_names_the_untrusted_package() -> None:
    reason = backend_rejection_reason(AltPlaintextBackend())

    assert reason is not None
    assert "keyrings.alt" in reason


def test_plaintext_named_reason_names_plaintext_storage() -> None:
    reason = backend_rejection_reason(PlaintextNamedBackend())

    assert reason is not None
    assert "plaintext" in reason


def test_rejection_error_carries_a_typed_reason() -> None:
    with pytest.raises(CredentialBackendRejectedError) as exc_info:
        _ = WindowsCredentialManagerStore(backend=FailLikeBackend())

    assert "keyring.backends.fail" in exc_info.value.reason


def test_describe_backend_reports_module_and_class() -> None:
    identity = describe_backend(WinVaultKeyring())

    assert identity == BackendIdentity(
        module="keyring.backends.Windows",
        class_name="WinVaultKeyring",
    )
