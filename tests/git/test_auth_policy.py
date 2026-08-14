"""Tests for Git auth policy selection and environment application."""

from __future__ import annotations

from pathlib import Path

import pytest

from hubfetch.credentials.models import (
    InvalidCredentialAliasError,
    parse_credential_alias,
)
from hubfetch.git.askpass_session import (
    AskPassSession,
    AskPassSessionError,
    open_askpass_session,
)
from hubfetch.git.auth_policy import (
    ASKPASS_ALIAS_VARIABLE,
    GitAuthMode,
    GitAuthPolicy,
    InvalidGitAuthPolicyError,
    apply_git_auth_environment,
    sanitized_support_environment,
)
from hubfetch.security.redaction import REDACTED

ALIAS = parse_credential_alias("hfc-" + "0" * 32)
ASKPASS_EXECUTABLE = Path("C:/Program Files/HubFetch/HubFetchAskPass.exe")


def _parent_environment() -> dict[str, str]:
    """Return a realistic git-worker environment snapshot with SSH/GCM state."""
    return {
        "PATH": "C:/Program Files/Git/cmd;C:/Windows/System32",
        "SSH_AUTH_SOCK": "C:/temp/ssh-agent.sock",
        "GCM_CREDENTIAL_STORE": "manager",
        "HOME": "C:/Users/test",
    }


def test_system_policy_leaves_ssh_and_gcm_untouched() -> None:
    """Given SYSTEM policy, the environment passes through byte-for-byte."""
    parent = _parent_environment()

    applied = apply_git_auth_environment(
        parent, GitAuthPolicy.system(), askpass_executable=ASKPASS_EXECUTABLE
    )

    assert applied == parent
    assert "GIT_ASKPASS" not in applied
    assert "SSH_ASKPASS" not in applied
    assert ASKPASS_ALIAS_VARIABLE not in applied
    assert applied["SSH_AUTH_SOCK"] == "C:/temp/ssh-agent.sock"
    assert applied["GCM_CREDENTIAL_STORE"] == "manager"


def test_system_policy_never_carries_an_alias() -> None:
    """Given SYSTEM mode with an alias, the policy is unrepresentable."""
    with pytest.raises(InvalidGitAuthPolicyError):
        _ = GitAuthPolicy(mode=GitAuthMode.SYSTEM, alias=ALIAS)


def test_app_token_policy_requires_an_alias() -> None:
    """Given APP_TOKEN mode without an alias, the policy is unrepresentable."""
    with pytest.raises(InvalidGitAuthPolicyError):
        _ = GitAuthPolicy(mode=GitAuthMode.APP_TOKEN)


def test_app_token_points_askpass_at_the_packaged_helper() -> None:
    """Given APP_TOKEN policy, the helper and alias locator are configured."""
    parent = _parent_environment()

    applied = apply_git_auth_environment(
        parent, GitAuthPolicy.app_token(ALIAS), askpass_executable=ASKPASS_EXECUTABLE
    )

    assert applied["GIT_ASKPASS"] == str(ASKPASS_EXECUTABLE)
    assert applied["SSH_ASKPASS"] == str(ASKPASS_EXECUTABLE)
    assert applied["SSH_ASKPASS_REQUIRE"] == "force"
    assert applied["GIT_TERMINAL_PROMPT"] == "0"
    assert applied["GCM_INTERACTIVE"] == "Never"
    assert applied[ASKPASS_ALIAS_VARIABLE] == ALIAS
    assert "SSH_AUTH_SOCK" in applied
    assert "GCM_CREDENTIAL_STORE" in applied


def test_app_token_disables_configured_credential_helpers() -> None:
    """Given APP_TOKEN policy, process-local helpers are neutralized."""
    parent = _parent_environment()

    applied = apply_git_auth_environment(
        parent, GitAuthPolicy.app_token(ALIAS), askpass_executable=ASKPASS_EXECUTABLE
    )

    assert applied["GIT_CONFIG_COUNT"] == "1"
    assert applied["GIT_CONFIG_KEY_0"] == "credential.helper"
    assert applied["GIT_CONFIG_VALUE_0"] == ""


def test_app_token_appends_to_existing_git_config_overrides() -> None:
    """Given existing process-local GIT_CONFIG_* entries, they are preserved."""
    parent = {
        "GIT_CONFIG_COUNT": "2",
        "GIT_CONFIG_KEY_0": "user.name",
        "GIT_CONFIG_VALUE_0": "test",
        "GIT_CONFIG_KEY_1": "credential.helper",
        "GIT_CONFIG_VALUE_1": "manager",
    }

    applied = apply_git_auth_environment(
        parent, GitAuthPolicy.app_token(ALIAS), askpass_executable=ASKPASS_EXECUTABLE
    )

    assert applied["GIT_CONFIG_COUNT"] == "3"
    assert applied["GIT_CONFIG_KEY_0"] == "user.name"
    assert applied["GIT_CONFIG_KEY_1"] == "credential.helper"
    assert applied["GIT_CONFIG_KEY_2"] == "credential.helper"
    assert applied["GIT_CONFIG_VALUE_2"] == ""


def test_app_token_rejects_invalid_alias_format() -> None:
    """Given a non-opaque alias, the app-token policy fails at the boundary."""
    with pytest.raises(InvalidCredentialAliasError):
        _ = GitAuthPolicy.app_token(parse_credential_alias("hub-user-token"))


def test_app_token_environment_never_contains_the_token() -> None:
    """Given an app-token policy, no environment value is the resolved token."""
    applied = apply_git_auth_environment(
        _parent_environment(),
        GitAuthPolicy.app_token(ALIAS),
        askpass_executable=ASKPASS_EXECUTABLE,
    )

    assert all(value != "hf_test_secret_123" for value in applied.values())
    assert applied[ASKPASS_ALIAS_VARIABLE] == ALIAS


def test_sanitized_environment_redacts_the_alias_locator() -> None:
    """Given a support snapshot, the alias locator is redacted but kept."""
    applied = apply_git_auth_environment(
        _parent_environment(),
        GitAuthPolicy.app_token(ALIAS),
        askpass_executable=ASKPASS_EXECUTABLE,
    )

    sanitized = sanitized_support_environment(applied)

    assert sanitized[ASKPASS_ALIAS_VARIABLE] == REDACTED
    assert sanitized["GIT_ASKPASS"] == str(ASKPASS_EXECUTABLE)


def test_open_session_yields_a_bounded_environment_snapshot() -> None:
    """Given an open session, the env additions are valid while not expired."""
    with open_askpass_session(
        ALIAS, askpass_executable=ASKPASS_EXECUTABLE, lifetime_seconds=30.0
    ) as session:
        environment = session.environment(_parent_environment())

        assert session.expired(now=0.0) is False
        assert environment[ASKPASS_ALIAS_VARIABLE] == ALIAS


def test_open_session_rejects_non_opaque_alias() -> None:
    """Given a non-opaque alias, opening a session fails closed."""
    with (
        pytest.raises(InvalidCredentialAliasError),
        open_askpass_session(
            parse_credential_alias("not-an-alias"),
            askpass_executable=ASKPASS_EXECUTABLE,
        ),
    ):
        pass


def test_expired_session_refuses_to_build_environment() -> None:
    """Given an expired session, environment application raises."""
    captured: list[AskPassSession] = []

    with open_askpass_session(
        ALIAS, askpass_executable=ASKPASS_EXECUTABLE, lifetime_seconds=1.0
    ) as active:
        captured.append(active)
    session = captured[0]
    assert session.expired(now=session.expires_at + 1.0) is True
    with pytest.raises(AskPassSessionError):
        _ = session.environment(_parent_environment(), now=session.expires_at + 1.0)
