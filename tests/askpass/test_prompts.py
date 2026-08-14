"""Tests for AskPass prompt classification and helper responses."""

from __future__ import annotations

import io
from typing import TYPE_CHECKING, Final, override

from hubfetch.askpass.main import run_askpass
from hubfetch.askpass.prompts import PromptKind, classify_prompt
from hubfetch.credentials.models import (
    BackendIdentity,
    CredentialAlias,
    parse_credential_alias,
)
from hubfetch.credentials.port import (
    CredentialBackendError,
    CredentialNotFoundError,
    CredentialStore,
)
from tests.conftest import HF_TEST_SECRET

if TYPE_CHECKING:
    from collections.abc import Mapping

ALIAS: Final = parse_credential_alias("hfc-" + "1" * 32)


class InMemoryStore(CredentialStore):
    """Credential store double backed by a plain dict."""

    def __init__(
        self, values: Mapping[str, str] | None = None, *, failing: bool = False
    ) -> None:
        super().__init__()
        self._values: dict[str, str] = dict(values or {})
        self._failing: bool = failing

    @override
    def create(self, *, token: str) -> CredentialAlias:
        alias = parse_credential_alias("hfc-" + "2" * 32)
        self._values[alias] = token
        return alias

    @override
    def replace(self, alias: CredentialAlias, *, token: str) -> None:
        self._values[alias] = token

    @override
    def resolve(self, alias: CredentialAlias) -> str:
        if self._failing:
            raise CredentialBackendError(reason="vault unreachable")
        if alias not in self._values:
            raise CredentialNotFoundError(reason=f"alias {alias} has no token")
        return self._values[alias]

    @override
    def delete(self, alias: CredentialAlias) -> None:
        _ = self._values.pop(alias, None)

    @property
    @override
    def backend_identity(self) -> BackendIdentity:
        return BackendIdentity(
            module="tests.askpass.test_prompts", class_name="InMemoryStore"
        )


def _run(
    *args: str,
    environment: Mapping[str, str] | None = None,
    store: CredentialStore | None = None,
) -> tuple[int, str, str]:
    """Run the helper against captured stdout/stderr and return all three."""
    stdout = io.StringIO()
    stderr = io.StringIO()
    code = run_askpass(
        args,
        environment=environment or {},
        store=store if store is not None else InMemoryStore(),
        stdout=stdout,
        stderr=stderr,
    )
    return code, stdout.getvalue(), stderr.getvalue()


def test_classify_username_for_prompt() -> None:
    assert (
        classify_prompt("Username for 'https://huggingface.co':") is PromptKind.USERNAME
    )


def test_classify_username_is_case_insensitive() -> None:
    assert (
        classify_prompt("username for 'https://example.invalid':")
        is PromptKind.USERNAME
    )


def test_classify_password_for_prompt() -> None:
    assert (
        classify_prompt("Password for 'https://user@huggingface.co':")
        is PromptKind.PASSWORD
    )


def test_classify_ssh_password_prompt() -> None:
    assert classify_prompt("user@example.invalid's password:") is PromptKind.PASSWORD


def test_classify_ssh_passphrase_prompt() -> None:
    assert (
        classify_prompt("Enter passphrase for key '/c/Users/test/.ssh/id_ed25519':")
        is PromptKind.PASSWORD
    )


def test_classify_password_ignores_windows_line_ending() -> None:
    assert (
        classify_prompt("Password for 'https://user@huggingface.co':\r\n")
        is PromptKind.PASSWORD
    )
    assert (
        classify_prompt("Username for 'https://huggingface.co':\r")
        is PromptKind.USERNAME
    )


def test_classify_empty_and_unknown_prompts_fail_closed() -> None:
    assert classify_prompt("") is PromptKind.UNKNOWN
    assert classify_prompt("fatal: could not read Username") is PromptKind.UNKNOWN
    assert classify_prompt("Enter host key passphrase?") is PromptKind.UNKNOWN


def test_username_prompt_returns_hf_user_exactly() -> None:
    code, stdout, stderr = _run("askpass.exe", "Username for 'https://huggingface.co':")

    assert code == 0
    assert stdout == "hf_user\n"
    assert stderr == ""


def test_password_prompt_returns_the_resolved_token_exactly() -> None:
    store = InMemoryStore({ALIAS: HF_TEST_SECRET})
    environment = {"HUBFETCH_ASKPASS_ALIAS": ALIAS}

    code, stdout, stderr = _run(
        "askpass.exe",
        "Password for 'https://hf_user@huggingface.co':",
        environment=environment,
        store=store,
    )

    assert code == 0
    assert stdout == f"{HF_TEST_SECRET}\n"
    assert stderr == ""


def test_unknown_prompt_fails_closed_without_echoing_prompt() -> None:
    store = InMemoryStore({ALIAS: HF_TEST_SECRET})
    environment = {"HUBFETCH_ASKPASS_ALIAS": ALIAS}

    code, stdout, stderr = _run(
        "askpass.exe",
        "fatal: could not read Username",
        environment=environment,
        store=store,
    )

    assert code == 1
    assert stdout == ""
    assert "fatal" not in stderr
    assert HF_TEST_SECRET not in stderr


def test_missing_alias_fails_closed() -> None:
    code, stdout, stderr = _run(
        "askpass.exe", "Password for 'https://hf_user@huggingface.co':"
    )

    assert code == 1
    assert stdout == ""
    assert HF_TEST_SECRET not in stderr


def test_invalid_alias_fails_closed() -> None:
    code, stdout, _ = _run(
        "askpass.exe",
        "Password for 'https://hf_user@huggingface.co':",
        environment={"HUBFETCH_ASKPASS_ALIAS": "not-an-opaque-alias"},
    )

    assert code == 1
    assert stdout == ""


def test_unknown_alias_fails_closed() -> None:
    code, stdout, stderr = _run(
        "askpass.exe",
        "Password for 'https://hf_user@huggingface.co':",
        environment={"HUBFETCH_ASKPASS_ALIAS": ALIAS},
    )

    assert code == 1
    assert stdout == ""
    assert HF_TEST_SECRET not in stderr


def test_backend_failure_fails_closed() -> None:
    store = InMemoryStore({ALIAS: HF_TEST_SECRET}, failing=True)
    environment = {"HUBFETCH_ASKPASS_ALIAS": ALIAS}

    code, stdout, stderr = _run(
        "askpass.exe",
        "Password for 'https://hf_user@huggingface.co':",
        environment=environment,
        store=store,
    )

    assert code == 1
    assert stdout == ""
    assert HF_TEST_SECRET not in stderr


def test_token_with_embedded_newline_fails_closed() -> None:
    store = InMemoryStore({ALIAS: "line1\nline2"})
    environment = {"HUBFETCH_ASKPASS_ALIAS": ALIAS}

    code, stdout, stderr = _run(
        "askpass.exe",
        "Password for 'https://hf_user@huggingface.co':",
        environment=environment,
        store=store,
    )

    assert code == 1
    assert stdout == ""
    assert "line1" not in stderr


def test_usage_error_without_prompt_argument() -> None:
    code, stdout, _ = _run("askpass.exe")

    assert code == 2
    assert stdout == ""
