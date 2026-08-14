"""Local bare Git repositories for deterministic tests."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Generator


class GitToolMissingError(RuntimeError):
    """Indicate that the system Git executable is unavailable."""

    def __init__(self) -> None:
        super().__init__("system Git executable was not found")


@dataclass(frozen=True, slots=True)
class BareGitRepository:
    """Describe a temporary local bare repository."""

    path: Path


def _git_executable() -> str:
    executable = shutil.which("git")
    if executable is None:
        raise GitToolMissingError
    return executable


@contextmanager
def bare_git_repository(
    *, parent: Path, namespace: str
) -> Generator[BareGitRepository, None, None]:
    """Create and remove a namespaced bare repository with system Git."""
    repository_root = Path(
        tempfile.mkdtemp(prefix=f"{namespace}-git-", dir=str(parent))
    )
    repository_path = repository_root / "repository.git"
    try:
        _ = subprocess.run(  # noqa: S603
            [
                _git_executable(),
                "init",
                "--bare",
                "--initial-branch=main",
                str(repository_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        yield BareGitRepository(path=repository_path)
    finally:
        shutil.rmtree(repository_root)
