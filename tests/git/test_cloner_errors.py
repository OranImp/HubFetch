"""Tests for mapping failed clone exit codes and stderr to typed errors.

Each case scripts a fake ``git`` that exits 128 with one documented stderr
category and asserts the cloner raises the matching Todo 6 typed error.
Gated-repository rejection is checked before the generic 403 access messages
it also contains.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Final

import pytest

from hubfetch.domain.errors import (
    AuthenticationError,
    DependencyError,
    DiskError,
    GatedAccessError,
    InternalError,
    NetworkError,
    NotFoundError,
)
from hubfetch.git.cloner import GitCloner
from tests.git.conftest import VERSION_HANDLER, FakeGitHandler

if TYPE_CHECKING:
    from pathlib import Path

FakeGitBuilder = Callable[..., tuple[tuple[str, ...], dict[str, str]]]

URL: Final = "https://huggingface.co/author/model"

_AUTH_PROMPT_DISABLED: Final = (
    "fatal: could not read Username: terminal prompts disabled\n"
)
_AUTH_REJECTED: Final = (
    "fatal: Authentication failed for 'https://huggingface.co/author/model/'\n"
)
_NOT_FOUND_REPO: Final = (
    "remote: Repository not found.\n"
    "fatal: repository 'https://huggingface.co/x/y' not found\n"
)
_UNRESOLVED_HOST: Final = (
    "fatal: unable to access 'https://huggingface.co/x/y': Could not resolve host\n"
)
_DISK_FULL: Final = (
    "fatal: unable to create file 'C:/x/file': No space left on device\n"
)
_NONEMPTY_DESTINATION: Final = (
    "fatal: destination path already exists and is not an empty directory\n"
)
_XET_FILTER_FAILED: Final = "fatal: external filter 'git-xet filter' failed\n"
_GATED_REPOSITORY: Final = (
    "remote: Access to repository author/repo is disabled.\n"
    "fatal: The requested URL returned error: 403\n"
)
_UNRECOGNIZED: Final = "fatal: an unrecognized failure\n"

_CLONE_ERROR_CASES: Final = (
    (_AUTH_PROMPT_DISABLED, AuthenticationError),
    (_AUTH_REJECTED, AuthenticationError),
    (_NOT_FOUND_REPO, NotFoundError),
    (_UNRESOLVED_HOST, NetworkError),
    (_DISK_FULL, DiskError),
    (_NONEMPTY_DESTINATION, DiskError),
    (_XET_FILTER_FAILED, DependencyError),
    (_GATED_REPOSITORY, GatedAccessError),
    (_UNRECOGNIZED, InternalError),
)


class TestCloneErrorMapping:
    """Exit codes and stderr categories map to typed errors."""

    @pytest.mark.parametrize(("stderr_text", "expected"), _CLONE_ERROR_CASES)
    def test_clone_maps_stderr_to_typed_error(
        self,
        tmp_path: Path,
        fake_git: FakeGitBuilder,
        stderr_text: str,
        expected: type[BaseException],
    ) -> None:
        """Given a failing clone, the stderr category selects the typed error."""
        destination = tmp_path / "dest"
        handler = FakeGitHandler(
            match=("clone",), stderr=((stderr_text, 0.0),), exit_code=128
        )
        command, environment = fake_git([VERSION_HANDLER, handler])
        cloner = GitCloner(git_command=command, environment=environment)

        with pytest.raises(expected):
            _ = cloner.clone(URL, destination)
