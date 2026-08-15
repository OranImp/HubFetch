"""Given/When/Then tests for the disposable AskPass credential contract.

The portable smoke exercises one disposable alias/token pair through the real
Windows Credential Manager store and the packaged AskPass executable. These
tests lock the shared contract logic with an in-memory store and a fake
spawner so the offline gate cannot drift from the packaged smoke.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, final, override

from hubfetch import smoke
from hubfetch.credentials.models import (
    BackendIdentity,
    CredentialAlias,
    generate_credential_alias,
    parse_credential_alias,
)
from hubfetch.credentials.port import (
    CredentialBackendError,
    CredentialError,
    CredentialNotFoundError,
    CredentialStore,
)
from hubfetch.git.auth_policy import ASKPASS_ALIAS_VARIABLE

if TYPE_CHECKING:
    from collections.abc import Mapping


@final
class _FakeStore(CredentialStore):
    """In-memory credential store used to exercise the AskPass contract."""

    _tokens: dict[str, str]
    _fail_create: bool
    deleted: list[CredentialAlias]
    last_alias: CredentialAlias | None

    def __init__(self, *, fail_create: bool = False) -> None:
        self._tokens = {}
        self._fail_create = fail_create
        self.deleted = []
        self.last_alias = None

    @override
    def create(self, *, token: str) -> CredentialAlias:
        if self._fail_create:
            raise CredentialBackendError(reason="create rejected")
        alias = generate_credential_alias()
        self._tokens[alias] = token
        self.last_alias = alias
        return alias

    @override
    def replace(self, alias: CredentialAlias, *, token: str) -> None:
        self._require(alias)
        self._tokens[alias] = token

    @override
    def resolve(self, alias: CredentialAlias) -> str:
        self._require(alias)
        return self._tokens[alias]

    @override
    def delete(self, alias: CredentialAlias) -> None:
        self._require(alias)
        del self._tokens[alias]
        self.deleted.append(alias)

    @property
    @override
    def backend_identity(self) -> BackendIdentity:
        return BackendIdentity(module="tests.fake", class_name="FakeStore")

    def _require(self, alias: CredentialAlias) -> None:
        if alias not in self._tokens:
            raise CredentialNotFoundError(reason=f"alias {alias} has no token")


def _fake_spawner(store: _FakeStore) -> smoke.AskPassSpawner:
    """Return a spawner answering like the packaged AskPass executable."""

    def spawn(prompt: str, environment: Mapping[str, str]) -> smoke.SpawnResult:
        alias_raw = environment.get(ASKPASS_ALIAS_VARIABLE)
        if alias_raw is None:
            return smoke.SpawnResult(returncode=1, stdout=b"")
        try:
            token = store.resolve(parse_credential_alias(alias_raw))
        except CredentialError:
            return smoke.SpawnResult(returncode=1, stdout=b"")
        match prompt:
            case "Username for 'https://huggingface.co':":
                return smoke.SpawnResult(returncode=0, stdout=b"hf_user\n")
            case "Password for 'hf_user@huggingface.co':":
                return smoke.SpawnResult(returncode=0, stdout=f"{token}\n".encode())
            case _:
                return smoke.SpawnResult(returncode=2, stdout=b"")

    return spawn


def test_askpass_contract_succeeds_with_fake_store() -> None:
    """Given a disposable credential, When the contract runs, Then the AskPass
    answers match and the credential is deleted.
    """
    store = _FakeStore()

    result = smoke.run_askpass_contract(
        store=store,
        spawner=_fake_spawner(store),
        environment={},
    )

    assert result.alias_created is True
    assert result.username_outcome is True
    assert result.password_outcome is True
    assert result.token_matched is True
    assert result.token_deleted is True
    assert result.error is None
    assert store.last_alias is not None
    assert store.deleted == [store.last_alias]


def test_askpass_contract_fails_closed_on_token_mismatch() -> None:
    """Given a wrong-token spawner, When the contract runs, Then it fails closed."""
    store = _FakeStore()

    def wrong_spawner(prompt: str, environment: Mapping[str, str]) -> smoke.SpawnResult:
        if ASKPASS_ALIAS_VARIABLE not in environment:
            return smoke.SpawnResult(returncode=1, stdout=b"")
        if prompt == "Password for 'hf_user@huggingface.co':":
            return smoke.SpawnResult(returncode=0, stdout=b"different-token\n")
        return smoke.SpawnResult(returncode=0, stdout=b"hf_user\n")

    result = smoke.run_askpass_contract(
        store=store,
        spawner=wrong_spawner,
        environment={},
    )

    assert result.token_matched is False
    assert result.error is not None
    assert result.token_deleted is True


def test_askpass_contract_records_store_failure() -> None:
    """Given a rejecting store, When the contract runs, Then it fails closed."""
    store = _FakeStore(fail_create=True)

    result = smoke.run_askpass_contract(
        store=store,
        spawner=_fake_spawner(store),
        environment={},
    )

    assert result.alias_created is False
    assert result.error is not None
    assert result.token_deleted is False
