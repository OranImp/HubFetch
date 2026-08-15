"""Disposable AskPass credential-contract smoke for the portable archive.

The contract creates a fresh alias/token pair through the real Windows
Credential Manager store, answers the username and password prompts through
the packaged ``HubFetchAskPass.exe``, requires the resolved token to match, and
always deletes the credential before returning so no trace remains. The
spawner is injected so offline pytest can exercise the same contract with an
in-memory store and a fake subprocess.
"""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final, Protocol
from uuid import uuid4

from hubfetch.credentials.port import CredentialError
from hubfetch.credentials.windows_keyring import WindowsCredentialManagerStore
from hubfetch.git.auth_policy import ASKPASS_ALIAS_VARIABLE

from ._contract import AskPassContractResult

if TYPE_CHECKING:
    from collections.abc import Mapping

    from hubfetch.credentials.models import CredentialAlias
    from hubfetch.credentials.port import CredentialStore

_HF_USERNAME: Final = b"hf_user"
"""AskPass username contract, mirroring ``hubfetch.askpass.main.HF_USERNAME``."""

_USERNAME_PROMPT: Final = "Username for 'https://huggingface.co':"
_PASSWORD_PROMPT: Final = "Password for 'hf_user@huggingface.co':"  # noqa: S105 - Git prompt shape, not a credential
"""Git-shaped AskPass prompts matching hubfetch.askpass.prompts.classify_prompt."""


@dataclass(frozen=True, slots=True)
class SpawnResult:
    """One AskPass subprocess outcome captured without echoing the token."""

    returncode: int
    stdout: bytes


class AskPassSpawner(Protocol):
    """Answers one AskPass prompt against a child environment."""

    def __call__(self, prompt: str, environment: Mapping[str, str]) -> SpawnResult:
        """Return the spawned helper's outcome for one prompt."""
        ...


def run_askpass_contract(
    *,
    store: CredentialStore,
    spawner: AskPassSpawner,
    environment: Mapping[str, str],
) -> AskPassContractResult:
    """Exercise the AskPass contract against one disposable credential."""
    token = f"hfsmoke-{uuid4().hex}"
    created_alias: CredentialAlias | None = None
    error: str | None = None
    try:
        created_alias = store.create(token=token)
    except CredentialError as caught:
        error = f"create: {caught}"
    username_ok = False
    password_ok = False
    token_matched = False
    if created_alias is not None and error is None:
        child = dict(environment)
        child[ASKPASS_ALIAS_VARIABLE] = created_alias
        try:
            username = spawner(_USERNAME_PROMPT, child)
            username_ok = (
                username.returncode == 0 and username.stdout.strip() == _HF_USERNAME
            )
        except OSError as caught:
            error = f"username spawn: {caught}"
        if error is None:
            try:
                password = spawner(_PASSWORD_PROMPT, child)
                password_ok = password.returncode == 0
                token_matched = password.stdout.strip() == token.encode("ascii")
                if password_ok and not token_matched:
                    error = "resolved token did not match the disposable credential"
            except OSError as caught:
                error = f"password spawn: {caught}"
    deleted = False
    if created_alias is not None:
        try:
            store.delete(created_alias)
            deleted = True
        except CredentialError as caught:
            if error is None:
                error = f"delete: {caught}"
    return AskPassContractResult(
        backend=_backend_identity(store),
        alias_created=created_alias is not None,
        username_outcome=username_ok,
        password_outcome=password_ok,
        token_matched=token_matched,
        token_deleted=deleted,
        error=error,
    )


def _backend_identity(store: CredentialStore) -> str:
    """Return the verified backend module and class as one diagnostic string."""
    identity = store.backend_identity
    return f"{identity.module}.{identity.class_name}"


def _packaged_askpass_spawner(exe: Path) -> AskPassSpawner:
    """Return a spawner that answers AskPass prompts through the packaged exe."""

    def spawn(prompt: str, environment: Mapping[str, str]) -> SpawnResult:
        completed = subprocess.run(  # noqa: S603
            [str(exe), prompt],
            env=dict(environment),
            capture_output=True,
            timeout=30,
            check=False,
        )
        return SpawnResult(returncode=completed.returncode, stdout=completed.stdout)

    return spawn


def run_packaged_askpass(errors: list[str]) -> AskPassContractResult | None:
    """Run the AskPass contract against the real Windows Credential Manager."""
    try:
        store: CredentialStore = WindowsCredentialManagerStore()
    except CredentialError as error:
        errors.append(f"askpass store: {error}")
        return None
    exe = Path(sys.executable).with_name("HubFetchAskPass.exe")
    if not exe.is_file():
        errors.append(f"askpass executable missing: {exe}")
        return None
    return run_askpass_contract(
        store=store,
        spawner=_packaged_askpass_spawner(exe),
        environment=os.environ,
    )
