"""Recognition of Git's AskPass username and password prompt classes.

Git spawns the ``GIT_ASKPASS``/``SSH_ASKPASS`` helper with the credential
prompt as a single argument. This module classifies that prompt structurally
into the exact classes the helper may answer: a username prompt, a password
prompt, an SSH key passphrase prompt, or anything else. Every prompt that does
not match one of those exact shapes is ``UNKNOWN`` so the helper fails closed
instead of echoing a response into an interactive dialog it does not own.
"""

from __future__ import annotations

from enum import StrEnum, unique

_USERNAME_PREFIX = "username"
_HTTPS_PASSWORD_MARKER = "password for '"  # noqa: S105 - prompt marker, not a credential
_SSH_PASSWORD_SUFFIX = "'s password:"  # noqa: S105 - prompt marker, not a credential
_PASSPHRASE_PREFIX = "enter passphrase for key '"  # noqa: S105 - prompt marker, not a credential
_PROMPT_QUOTED_SUFFIX = "':"


@unique
class PromptKind(StrEnum):
    """Closed classification of one AskPass prompt."""

    USERNAME = "username"
    PASSWORD = "password"  # noqa: S105 - prompt marker, not a credential
    UNKNOWN = "unknown"


def classify_prompt(prompt: str) -> PromptKind:
    """Return the AskPass prompt class for one raw prompt string.

    Git's HTTPS prompts are ``Username for '<url>':`` and ``Password for
    '<user>@<url>':``; the SSH variants are ``<user>@<host>'s password:`` and
    ``Enter passphrase for key '<path>':``. Each is matched by its exact
    structural shape, case-insensitively, after normalizing the line ending a
    Windows Git invocation may attach; a prompt that merely contains a
    credential keyword -- such as a host-key confirmation -- is ``UNKNOWN`` so
    the helper refuses to answer anything it cannot prove it owns.
    """
    folded = prompt.casefold().strip()
    if folded.startswith(_USERNAME_PREFIX):
        return PromptKind.USERNAME
    if folded.endswith(_SSH_PASSWORD_SUFFIX):
        return PromptKind.PASSWORD
    if _HTTPS_PASSWORD_MARKER in folded and folded.endswith(_PROMPT_QUOTED_SUFFIX):
        return PromptKind.PASSWORD
    if folded.startswith(_PASSPHRASE_PREFIX):
        return PromptKind.PASSWORD
    return PromptKind.UNKNOWN
