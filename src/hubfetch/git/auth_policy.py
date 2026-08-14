"""Git authentication policy: default SSH/GCM versus the HubFetch app token.

The policy has exactly two modes. :attr:`GitAuthMode.SYSTEM` -- the default --
leaves SSH to the user's agent/config and HTTPS to Git Credential Manager or
the configured safe helper; it adds or changes nothing. :attr:`GitAuthMode.APP_TOKEN`
is selected only when the user explicitly chooses a HubFetch credential
alias: for that one git process the competing interactive prompts are
disabled (``GIT_TERMINAL_PROMPT=0``, ``GCM_INTERACTIVE=Never``, and the
configured credential helpers are neutralized) and ``GIT_ASKPASS`` /
``SSH_ASKPASS`` are pointed at the packaged console AskPass executable plus a
non-secret opaque alias locator. Nothing here ever carries the token itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum, unique
from typing import TYPE_CHECKING, Final, override

from hubfetch.credentials.models import CredentialAlias, parse_credential_alias
from hubfetch.security.redaction import REDACTED

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path

ASKPASS_ALIAS_VARIABLE: Final = "HUBFETCH_ASKPASS_ALIAS"
"""Non-secret environment variable carrying the opaque alias locator.

The alias itself is opaque and secret-free (``hfc-<32 hex>``); only the token
behind it is a secret, and that is resolved by the helper from the vault and
never placed in the environment.
"""

_GIT_ASKPASS_VARIABLE: Final = "GIT_ASKPASS"
_SSH_ASKPASS_VARIABLE: Final = "SSH_ASKPASS"
_SSH_ASKPASS_REQUIRE_VARIABLE: Final = "SSH_ASKPASS_REQUIRE"
_GIT_TERMINAL_PROMPT_VARIABLE: Final = "GIT_TERMINAL_PROMPT"
_GCM_INTERACTIVE_VARIABLE: Final = "GCM_INTERACTIVE"
_GIT_CONFIG_COUNT_VARIABLE: Final = "GIT_CONFIG_COUNT"

_SSH_ASKPASS_REQUIRE_FORCE: Final = "force"
_GIT_TERMINAL_PROMPT_DISABLED: Final = "0"
_GCM_INTERACTIVE_NEVER: Final = "Never"

_APP_TOKEN_VARIABLES: Final = (
    (_GIT_ASKPASS_VARIABLE, None),
    (_SSH_ASKPASS_VARIABLE, None),
    (_SSH_ASKPASS_REQUIRE_VARIABLE, _SSH_ASKPASS_REQUIRE_FORCE),
    (_GIT_TERMINAL_PROMPT_VARIABLE, _GIT_TERMINAL_PROMPT_DISABLED),
    (_GCM_INTERACTIVE_VARIABLE, _GCM_INTERACTIVE_NEVER),
)
"""The exact variables app-token mode adds, in stable order."""


@unique
class GitAuthMode(StrEnum):
    """Closed modes of Git credential selection for one process."""

    SYSTEM = "system"
    APP_TOKEN = "app_token"  # noqa: S105 - enum tag, not a credential


@dataclass(frozen=True, slots=True)
class InvalidGitAuthPolicyError(ValueError):
    """A policy mode and alias combination is not representable."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid git auth policy: {self.reason}"


@dataclass(frozen=True, slots=True)
class GitAuthPolicy:
    """One immutable Git auth selection, validated at construction."""

    mode: GitAuthMode
    alias: CredentialAlias | None = None

    def __post_init__(self) -> None:
        """Make illegal combinations unrepresentable before use."""
        match self.mode:
            case GitAuthMode.SYSTEM:
                if self.alias is not None:
                    raise InvalidGitAuthPolicyError(
                        reason="system mode never carries a credential alias"
                    )
            case GitAuthMode.APP_TOKEN:
                if self.alias is None:
                    raise InvalidGitAuthPolicyError(
                        reason="app-token mode requires a credential alias"
                    )

    @classmethod
    def system(cls) -> GitAuthPolicy:
        """Return the default policy that leaves SSH and GCM untouched."""
        return cls(mode=GitAuthMode.SYSTEM)

    @classmethod
    def app_token(cls, alias: CredentialAlias) -> GitAuthPolicy:
        """Return an app-token policy for one validated opaque alias."""
        _ = parse_credential_alias(alias)
        return cls(mode=GitAuthMode.APP_TOKEN, alias=alias)


def apply_git_auth_environment(
    environment: Mapping[str, str],
    policy: GitAuthPolicy,
    *,
    askpass_executable: Path,
) -> dict[str, str]:
    """Return a copy of ``environment`` tuned for one git process.

    ``SYSTEM`` returns the environment unchanged: SSH keeps the user's
    agent/config and HTTPS keeps Git Credential Manager or the configured
    safe helper. ``APP_TOKEN`` disables competing interactive prompts,
    neutralizes configured credential helpers for this process, points
    ``GIT_ASKPASS``/``SSH_ASKPASS`` at the standalone AskPass executable, and
    adds the non-secret alias locator. The token is never part of this
    environment.
    """
    result = dict(environment)
    match policy.mode:
        case GitAuthMode.SYSTEM:
            return result
        case GitAuthMode.APP_TOKEN:
            return _apply_app_token(
                result, policy, askpass_executable=askpass_executable
            )


def sanitized_support_environment(
    environment: Mapping[str, str],
) -> dict[str, str]:
    """Return an environment view safe for support output.

    The alias locator is non-secret but is still replaced with the redaction
    marker so support bundles never disclose which alias a task used.
    """
    result = dict(environment)
    if ASKPASS_ALIAS_VARIABLE in result:
        result[ASKPASS_ALIAS_VARIABLE] = REDACTED
    return result


def _apply_app_token(
    environment: dict[str, str],
    policy: GitAuthPolicy,
    *,
    askpass_executable: Path,
) -> dict[str, str]:
    executable = str(askpass_executable)
    result = dict(environment)
    for variable, fixed_value in _APP_TOKEN_VARIABLES:
        value = executable if fixed_value is None else fixed_value
        result[variable] = value
    alias = policy.alias
    if alias is None:
        raise InvalidGitAuthPolicyError(
            reason="app-token mode requires a credential alias"
        )
    result[ASKPASS_ALIAS_VARIABLE] = alias
    return _disable_configured_helpers(result)


def _disable_configured_helpers(environment: dict[str, str]) -> dict[str, str]:
    """Neutralize every configured credential helper for this process.

    Git reads ``credential.helper`` from config; an empty value resets the
    helper list to none. Setting it through the ``GIT_CONFIG_*`` environment
    family overrides config without mutating any file, and appending to any
    existing ``GIT_CONFIG_COUNT`` preserves unrelated process-local overrides.
    """
    result = dict(environment)
    raw_count = result.get(_GIT_CONFIG_COUNT_VARIABLE, "0")
    try:
        count = int(raw_count)
    except ValueError:
        count = 0
    result[f"GIT_CONFIG_KEY_{count}"] = "credential.helper"
    result[f"GIT_CONFIG_VALUE_{count}"] = ""
    result[_GIT_CONFIG_COUNT_VARIABLE] = str(count + 1)
    return result
