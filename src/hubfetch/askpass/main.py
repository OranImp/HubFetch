"""Standalone console-mode AskPass entry point resolving HubFetch app tokens.

Git spawns this helper (through ``GIT_ASKPASS``/``SSH_ASKPASS``) with the
credential prompt as its single argument. The helper answers ``hf_user`` or
the token resolved directly from :class:`~hubfetch.credentials.port.CredentialStore`
only on stdout, writes only sanitized diagnostics to stderr, and exits
nonzero for unknown prompts, missing/unknown aliases, and backend failures
so Git fails closed instead of hanging or echoing a secret.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, TextIO, override

from hubfetch.credentials.models import (
    InvalidCredentialAliasError,
    parse_credential_alias,
)
from hubfetch.credentials.port import CredentialError, CredentialStore
from hubfetch.credentials.windows_keyring import WindowsCredentialManagerStore
from hubfetch.git.auth_policy import ASKPASS_ALIAS_VARIABLE

from .prompts import PromptKind, classify_prompt

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

HF_USERNAME: Final = "hf_user"
"""Username Git sends for Hugging Face HTTPS auth; the token is the password."""

_EXIT_OK: Final = 0
_EXIT_FAILURE: Final = 1
_EXIT_USAGE: Final = 2
_EXPECTED_ARGV_LENGTH: Final = 2
"""Git always passes exactly one prompt argument to the AskPass helper."""


@dataclass(frozen=True, slots=True)
class AskPassError(RuntimeError):
    """A fail-closed AskPass outcome that must not echo the prompt or token."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"askpass failure: {self.reason}"


def run_askpass(
    argv: Sequence[str],
    *,
    environment: Mapping[str, str],
    store: CredentialStore,
    stdout: TextIO,
    stderr: TextIO,
) -> int:
    """Handle one AskPass invocation and return the process exit code.

    ``argv`` is the helper's argument list as spawned by Git: the executable
    path followed by exactly one prompt. The token is resolved through the
    injected store on demand and is written only to ``stdout``; every
    diagnostic written to ``stderr`` is a fixed sanitized message that never
    repeats the prompt, the remote URL, or the token.
    """
    if len(argv) != _EXPECTED_ARGV_LENGTH:
        _ = stderr.write("askpass: expected exactly one prompt argument\n")
        return _EXIT_USAGE
    kind = classify_prompt(argv[1])
    match kind:
        case PromptKind.USERNAME:
            _ = stdout.write(f"{HF_USERNAME}\n")
            stdout.flush()
            return _EXIT_OK
        case PromptKind.PASSWORD:
            return _resolve_token(
                environment=environment, store=store, stdout=stdout, stderr=stderr
            )
        case PromptKind.UNKNOWN:
            _ = stderr.write("askpass: unrecognized prompt class; refusing to answer\n")
            return _EXIT_FAILURE


def entry(argv: Sequence[str] | None = None) -> int:
    """Run the standalone helper against the real Windows credential store.

    This is the top-level boundary of the packaged console helper: the store
    is constructed from the verified Windows Credential Manager backend, and
    every credential failure is reported as a sanitized diagnostic with a
    nonzero exit so Git never receives a partial or echoed secret.
    """
    arguments = tuple(sys.argv) if argv is None else tuple(argv)
    try:
        store: CredentialStore = WindowsCredentialManagerStore()
    except CredentialError as error:
        return _fail_credential_backend(error, sys.stderr)
    return run_askpass(
        arguments,
        environment=os.environ,
        store=store,
        stdout=sys.stdout,
        stderr=sys.stderr,
    )


def _resolve_token(
    *,
    environment: Mapping[str, str],
    store: CredentialStore,
    stdout: TextIO,
    stderr: TextIO,
) -> int:
    alias_raw = environment.get(ASKPASS_ALIAS_VARIABLE)
    if alias_raw is None or not alias_raw:
        _ = stderr.write("askpass: no credential alias configured\n")
        return _EXIT_FAILURE
    try:
        alias = parse_credential_alias(alias_raw)
    except InvalidCredentialAliasError:
        _ = stderr.write("askpass: credential alias is invalid\n")
        return _EXIT_FAILURE
    try:
        token = store.resolve(alias)
    except CredentialError as error:
        return _fail_credential_backend(error, stderr)
    if "\n" in token or "\r" in token:
        _ = stderr.write("askpass: resolved token is not a single line\n")
        return _EXIT_FAILURE
    _ = stdout.write(f"{token}\n")
    stdout.flush()
    return _EXIT_OK


def _fail_credential_backend(error: CredentialError, stderr: TextIO) -> int:
    """Report a credential backend failure without echoing its raw message.

    The reason string may embed paths or vault details; only a fixed category
    label reaches stderr so diagnostics stay sanitized.
    """
    _ = error
    _ = stderr.write("askpass: credential backend unavailable\n")
    return _EXIT_FAILURE


if __name__ == "__main__":
    raise SystemExit(entry())
