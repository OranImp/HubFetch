"""Tests for the Windows Credential Manager credential store contract."""

from __future__ import annotations

from dataclasses import asdict

import pytest
from keyring.backends.Windows import WinVaultKeyring

from hubfetch.config.identity import APP_IDENTITY
from hubfetch.credentials.models import (
    CredentialAccount,
    CredentialDisplay,
    InvalidCredentialAliasError,
    parse_credential_alias,
)
from hubfetch.credentials.port import (
    CredentialBackendError,
    CredentialNotFoundError,
)
from hubfetch.credentials.windows_keyring import WindowsCredentialManagerStore
from hubfetch.security.redaction import Redactor, SecretRegistry
from tests.conftest import HF_TEST_SECRET
from tests.credentials.fakes import FailingWindowsVault, MemoryWindowsVault


@pytest.fixture
def store_pair() -> tuple[WindowsCredentialManagerStore, MemoryWindowsVault]:
    backend = MemoryWindowsVault()
    store = WindowsCredentialManagerStore(backend=backend)
    return store, backend


def test_create_returns_an_opaque_alias_and_stores_the_token(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, backend = store_pair

    alias = store.create(token=HF_TEST_SECRET)

    assert parse_credential_alias(alias) == alias
    assert store.resolve(alias) == HF_TEST_SECRET
    assert backend.set_calls == [
        (APP_IDENTITY.credentials_service, alias, HF_TEST_SECRET)
    ]


def test_created_aliases_are_unique(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, _ = store_pair

    first = store.create(token=HF_TEST_SECRET)
    second = store.create(token=HF_TEST_SECRET)

    assert first != second
    assert parse_credential_alias(first) == first
    assert parse_credential_alias(second) == second


def test_resolve_returns_the_stored_token(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, _ = store_pair
    alias = store.create(token=HF_TEST_SECRET)

    resolved = store.resolve(alias)

    assert resolved == HF_TEST_SECRET


def test_resolve_unknown_alias_raises_not_found(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, _ = store_pair
    unknown = parse_credential_alias("hfc-" + "0" * 32)

    with pytest.raises(CredentialNotFoundError):
        _ = store.resolve(unknown)


def test_replace_overwrites_the_token_for_an_existing_alias(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, _ = store_pair
    alias = store.create(token=HF_TEST_SECRET)
    replacement = f"{HF_TEST_SECRET}-rotated"

    store.replace(alias, token=replacement)

    assert store.resolve(alias) == replacement


def test_replace_unknown_alias_raises_not_found(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, _ = store_pair
    unknown = parse_credential_alias("hfc-" + "1" * 32)

    with pytest.raises(CredentialNotFoundError):
        store.replace(unknown, token=HF_TEST_SECRET)


def test_delete_removes_the_stored_token(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, backend = store_pair
    alias = store.create(token=HF_TEST_SECRET)

    store.delete(alias)

    assert backend.values == {}
    with pytest.raises(CredentialNotFoundError):
        _ = store.resolve(alias)


def test_delete_unknown_alias_raises_not_found(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, _ = store_pair
    unknown = parse_credential_alias("hfc-" + "2" * 32)

    with pytest.raises(CredentialNotFoundError):
        store.delete(unknown)


def test_credentials_are_scoped_to_the_credentials_service(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, backend = store_pair
    alias = store.create(token=HF_TEST_SECRET)

    assert set(backend.values) == {(APP_IDENTITY.credentials_service, alias)}


def test_a_different_service_cannot_resolve_an_alias(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, backend = store_pair
    alias = store.create(token=HF_TEST_SECRET)
    other = WindowsCredentialManagerStore(backend=backend, service="Other.Service")

    with pytest.raises(CredentialNotFoundError):
        _ = other.resolve(alias)


def test_vault_holds_only_the_opaque_alias_and_token(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, backend = store_pair
    alias = store.create(token=HF_TEST_SECRET)

    assert backend.values[(APP_IDENTITY.credentials_service, alias)] == HF_TEST_SECRET


def test_display_metadata_model_is_secret_free_and_frozen() -> None:
    display = CredentialDisplay(
        account=CredentialAccount("hub-user"),
        label="work machine",
    )

    assert asdict(display) == {"account": "hub-user", "label": "work machine"}
    assert "token" not in asdict(display)


def test_parse_rejects_non_opaque_alias_values() -> None:
    with pytest.raises(InvalidCredentialAliasError):
        _ = parse_credential_alias("hub-user-token")


def test_resolve_redacted_registers_the_token_while_active(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, _ = store_pair
    alias = store.create(token=HF_TEST_SECRET)
    registry = SecretRegistry()
    redactor = Redactor(registry=registry)

    with store.resolve_redacted(alias, registry=registry) as token:
        assert token == HF_TEST_SECRET
        assert HF_TEST_SECRET not in redactor.redact_text(token)

    assert HF_TEST_SECRET in redactor.redact_text(token)


def test_lifecycle_leaves_no_secret_material_in_the_vault(
    store_pair: tuple[WindowsCredentialManagerStore, MemoryWindowsVault],
) -> None:
    store, backend = store_pair
    alias = store.create(token=HF_TEST_SECRET)
    _ = store.resolve(alias)
    store.delete(alias)

    assert backend.values == {}
    assert HF_TEST_SECRET not in str(backend.values)
    assert HF_TEST_SECRET not in repr(store)


@pytest.mark.windows
def test_windows_credential_manager_roundtrip_deletes_in_finally() -> None:
    """Given the real Credential Manager, one credential round-trips once."""
    store = WindowsCredentialManagerStore(backend=WinVaultKeyring())
    alias = store.create(token=HF_TEST_SECRET)
    try:
        assert store.resolve(alias) == HF_TEST_SECRET
        assert store.backend_identity.module == "keyring.backends.Windows"
        assert store.backend_identity.class_name == "WinVaultKeyring"
    finally:
        store.delete(alias)

    with pytest.raises(CredentialNotFoundError):
        _ = store.resolve(alias)


def test_backend_failure_maps_to_a_typed_backend_error() -> None:
    store = WindowsCredentialManagerStore(backend=FailingWindowsVault())
    alias = parse_credential_alias("hfc-" + "3" * 32)

    with pytest.raises(CredentialBackendError):
        _ = store.resolve(alias)
