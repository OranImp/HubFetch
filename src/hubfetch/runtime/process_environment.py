"""Fresh per-worker ``QProcessEnvironment`` built without mutating the parent.

Each worker receives a brand new environment derived from a read-only parent
snapshot. Every mode strips credential-bearing and inherited AskPass/auth
variables, then applies the typed proxy policy from
:mod:`hubfetch.network.proxy`. Hub and Git workers share the same isolation
contract through the two entry points below, which are the parity seam used by
the transfer runtimes. ``os.environ``, machine/user settings, and the GUI
process environment are never modified.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from PySide6.QtCore import QProcessEnvironment

from hubfetch.network.proxy import ProxyPolicy, apply_proxy_policy

if TYPE_CHECKING:
    from collections.abc import Mapping

STRIPPED_VARIABLES: Final[tuple[str, ...]] = (
    "HF_TOKEN",
    "HF_TOKEN_PATH",
    "HUGGING_FACE_HUB_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
)
"""Credential-bearing and inherited AskPass/auth variables removed in every mode.

``HF_TOKEN`` overrides the machine token, ``HF_TOKEN_PATH`` points at shared
token storage, and the ``*_ASKPASS`` helpers carry inherited credential-prompt
programs. Auth adapters resolve credentials internally and never receive these
values through the environment.
"""

APP_VARIABLE_PREFIX: Final = "hubfetch_"
"""Case-folded prefix of app-reserved variables that never reach a worker."""

_STRIPPED_NAMES: Final = frozenset(name.casefold() for name in STRIPPED_VARIABLES)
"""Case-folded exact names compared against every inherited variable name."""


def environment_mapping(environment: QProcessEnvironment) -> dict[str, str]:
    """Read one ``QProcessEnvironment`` into a plain, assertion-friendly mapping."""
    names = environment.keys()
    return {name: environment.value(name) for name in names}


def _strip_secrets(environment: Mapping[str, str]) -> dict[str, str]:
    """Return a copy of ``environment`` with token and auth variables removed.

    Environment names are matched case-insensitively because Windows treats
    them that way, so both ``HF_TOKEN`` and ``hf_token`` are stripped.
    """
    result = dict(environment)
    for name in tuple(result):
        folded = name.casefold()
        if folded in _STRIPPED_NAMES or folded.startswith(APP_VARIABLE_PREFIX):
            del result[name]
    return result


def _isolated_environment(
    parent: Mapping[str, str], policy: ProxyPolicy
) -> QProcessEnvironment:
    """Build one fresh ``QProcessEnvironment`` from a read-only parent snapshot."""
    values = apply_proxy_policy(_strip_secrets(parent), policy)
    environment = QProcessEnvironment()
    for name, value in values.items():
        environment.insert(name, value)
    return environment


def hub_worker_environment(
    parent: Mapping[str, str], policy: ProxyPolicy
) -> QProcessEnvironment:
    """Build the fresh environment for a Hugging Face Hub transfer worker."""
    return _isolated_environment(parent, policy)


def git_worker_environment(
    parent: Mapping[str, str], policy: ProxyPolicy
) -> QProcessEnvironment:
    """Build the fresh environment for a Git clone worker.

    Both workers share the isolation contract today; this entry point is the
    parity seam that keeps the typed policy identical across Hub and Git.
    """
    return _isolated_environment(parent, policy)
