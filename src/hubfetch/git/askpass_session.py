"""Short-lived, access-controlled AskPass session for one git process.

A session binds one non-secret opaque alias to the packaged AskPass
executable for exactly one git invocation, snapshots the environment additions
that process needs, and refuses reuse after a bounded lifetime. The session
never holds the token: the helper resolves it directly from the credential
store on demand, so nothing in this module or its environment is a secret.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from time import monotonic
from typing import TYPE_CHECKING, Final, override

from hubfetch.credentials.models import CredentialAlias, parse_credential_alias
from hubfetch.git.auth_policy import (
    GitAuthPolicy,
    apply_git_auth_environment,
    sanitized_support_environment,
)

if TYPE_CHECKING:
    from collections.abc import Generator, Mapping
    from pathlib import Path

DEFAULT_SESSION_LIFETIME_SECONDS: Final = 30.0
"""Bounded window within which the snapshot may be applied to a git process."""


@dataclass(frozen=True, slots=True)
class AskPassSessionError(ValueError):
    """A session was misused or outlived its access window."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"askpass session: {self.reason}"


@dataclass(frozen=True, slots=True)
class AskPassSession:
    """One bounded app-token session for a single git process."""

    alias: CredentialAlias
    askpass_executable: Path
    expires_at: float

    @property
    def policy(self) -> GitAuthPolicy:
        """Return the immutable app-token policy this session represents."""
        return GitAuthPolicy.app_token(self.alias)

    def environment(
        self, parent: Mapping[str, str], *, now: float | None = None
    ) -> dict[str, str]:
        """Return the env additions for the git process, if still valid."""
        self._require_valid(now=now)
        return apply_git_auth_environment(
            parent, self.policy, askpass_executable=self.askpass_executable
        )

    def sanitized_environment(self, environment: Mapping[str, str]) -> dict[str, str]:
        """Return a support-safe view of one environment snapshot."""
        return sanitized_support_environment(environment)

    def expired(self, *, now: float | None = None) -> bool:
        """Return whether the session's access window has closed."""
        current = monotonic() if now is None else now
        return current > self.expires_at

    def _require_valid(self, *, now: float | None = None) -> None:
        if self.expired(now=now):
            raise AskPassSessionError(reason="session has expired")


@contextmanager
def open_askpass_session(
    alias: CredentialAlias,
    *,
    askpass_executable: Path,
    lifetime_seconds: float = DEFAULT_SESSION_LIFETIME_SECONDS,
) -> Generator[AskPassSession, None, None]:
    """Open one bounded app-token session for a single git process.

    The alias is validated at the opaque boundary; the session expires after
    ``lifetime_seconds`` of monotonic time, so a snapshot cannot be applied to
    a stale git invocation long after the user selected it.
    """
    _ = parse_credential_alias(alias)
    if lifetime_seconds <= 0:
        raise AskPassSessionError(reason="lifetime must be positive")
    session = AskPassSession(
        alias=alias,
        askpass_executable=askpass_executable,
        expires_at=monotonic() + lifetime_seconds,
    )
    yield session
