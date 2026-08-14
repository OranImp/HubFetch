"""Typed Git clone argv and environment models without a shell.

:func:`build_clone_argv` returns a literal argument list for ``git clone
--progress`` with ``--branch <revision>`` and ``--depth 1`` applied only when
the caller explicitly requested them; nothing is ever interpolated into a
shell command line. :func:`clone_environment` fixes the locale and disables
interactive prompts and progress throttling so stderr is stable, English, and
parseable by :mod:`hubfetch.git.progress`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path


@dataclass(frozen=True, slots=True)
class CloneOptions:
    """Optional clone behaviors selected explicitly by the caller.

    ``--branch`` is passed through only as a branch or tag reference: Git
    resolves it, so the cloner never claims an arbitrary commit checkout.
    ``shallow`` is honored only when the task explicitly selects it.
    """

    revision: str | None = None
    shallow: bool = False


def build_clone_argv(
    url: str,
    destination: Path,
    options: CloneOptions | None = None,
    *,
    git_command: tuple[str, ...] = ("git",),
) -> tuple[str, ...]:
    """Build the literal no-shell argv for one git clone.

    The destination and URL are plain arguments, never shell-expanded; a
    destination path containing shell metacharacters survives as one token.
    """
    selected = options if options is not None else CloneOptions()
    argv = [*git_command, "clone", "--progress"]
    if selected.revision is not None:
        argv.extend(("--branch", selected.revision))
    if selected.shallow:
        argv.extend(("--depth", "1"))
    argv.extend((url, str(destination)))
    return tuple(argv)


def clone_environment(parent: Mapping[str, str]) -> dict[str, str]:
    """Return a copy of ``parent`` tuned for stable, non-interactive Git stderr.

    ``LC_ALL=C`` forces English messages so progress parsing is stable across
    locales; ``GIT_PROGRESS_DELAY=0`` makes progress appear immediately on a
    pipe; ``GIT_TERMINAL_PROMPT=0`` makes auth failures fail fast instead of
    hanging a headless worker on an interactive prompt.
    """
    result = dict(parent)
    result["LC_ALL"] = "C"
    result["GIT_PROGRESS_DELAY"] = "0"
    result["GIT_TERMINAL_PROMPT"] = "0"
    return result
