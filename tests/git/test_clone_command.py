"""Tests for the typed clone URL and command models.

``clone_url`` builds Hugging Face model/dataset/Space HTTPS URLs and validates
user-provided SSH URLs without ever embedding credentials. ``clone_command``
builds the no-shell argv for ``git clone --progress`` and the stable stderr
environment. Both are pure so every test is deterministic.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

import pytest

from hubfetch.domain.ids import parse_repository_id
from hubfetch.domain.repository import (
    DatasetRepository,
    ModelRepository,
    RepositoryRef,
    SpaceRepository,
)
from hubfetch.git.clone_command import CloneOptions, build_clone_argv, clone_environment
from hubfetch.git.clone_url import (
    CloneUrlError,
    HttpsRepoUrl,
    SshRepoUrl,
    https_clone_url,
    ssh_clone_url,
)

SECRET: Final = "hf_test_secret_123"  # noqa: S105


def _repo(
    repo_id: str, kind: ModelRepository | DatasetRepository | SpaceRepository
) -> RepositoryRef:
    """Build one repository reference with no revision."""
    return RepositoryRef(repo_id=parse_repository_id(repo_id), kind=kind)


class TestHttpsRepoUrl:
    """The HTTPS clone URL derives the Hub path from the repository kind."""

    def test_https_url_for_model_repository(self) -> None:
        """Given a model repo, the URL points at the model path."""
        url = https_clone_url(_repo("author/model", ModelRepository()))

        assert isinstance(url, HttpsRepoUrl)
        assert url.value == "https://huggingface.co/author/model"

    def test_https_url_for_dataset_repository(self) -> None:
        """Given a dataset repo, the URL uses the datasets path segment."""
        url = https_clone_url(_repo("author/data", DatasetRepository()))

        assert url.value == "https://huggingface.co/datasets/author/data"

    def test_https_url_for_space_repository(self) -> None:
        """Given a Space repo, the URL uses the spaces path segment."""
        url = https_clone_url(_repo("author/space", SpaceRepository()))

        assert url.value == "https://huggingface.co/spaces/author/space"

    def test_https_url_never_embeds_credentials(self) -> None:
        """Given any repo, the derived URL carries no userinfo or query."""
        url = https_clone_url(_repo("author/model", ModelRepository()))

        assert "@" not in url.value
        assert "?" not in url.value
        assert url.value.startswith("https://huggingface.co/author/model")


class TestSshRepoUrl:
    """The SSH clone URL validates user-provided transport without credentials."""

    def test_ssh_url_accepts_scp_like_form(self) -> None:
        """Given an scp-like URL, the value is preserved for git."""
        url = ssh_clone_url("git@hf.co:author/repo")

        assert url == SshRepoUrl(value="git@hf.co:author/repo")

    def test_ssh_url_accepts_uri_form(self) -> None:
        """Given an ssh:// URL, the value is preserved for git."""
        url = ssh_clone_url("ssh://git@hf.co:2222/author/repo")

        assert url.value == "ssh://git@hf.co:2222/author/repo"

    @pytest.mark.parametrize(
        "raw",
        [
            "git:hunter2@hf.co:author/repo",
            "ssh://git:hunter2@hf.co/author/repo",
        ],
    )
    def test_ssh_url_rejects_embedded_password(self, raw: str) -> None:
        """Given a password-bearing URL, parsing refuses the credential."""
        with pytest.raises(CloneUrlError):
            _ = ssh_clone_url(raw)

    @pytest.mark.parametrize(
        "raw",
        ["", "   ", "git@hf.co:author repo", "git@hf.co:", "ssh://"],
    )
    def test_ssh_url_rejects_malformed_input(self, raw: str) -> None:
        """Given a malformed URL, parsing fails without echoing the value."""
        with pytest.raises(CloneUrlError):
            _ = ssh_clone_url(raw)


class TestCloneArgv:
    """The clone argv is a literal argument list with no shell."""

    def _build(self, options: CloneOptions | None = None) -> tuple[str, ...]:
        return build_clone_argv(
            "https://huggingface.co/author/model",
            Path("C:\\work\\model"),
            options,
        )

    def test_argv_clones_with_progress_by_default(self) -> None:
        """Given no options, the argv is git clone --progress url dest."""
        argv = self._build()

        assert argv == (
            "git",
            "clone",
            "--progress",
            "https://huggingface.co/author/model",
            "C:\\work\\model",
        )

    def test_argv_requests_branch_for_revision(self) -> None:
        """Given a revision, the argv adds --branch before the URL."""
        argv = self._build(CloneOptions(revision="v1.0"))

        assert "--branch" in argv
        assert argv[argv.index("--branch") + 1] == "v1.0"
        assert argv[-1] == "C:\\work\\model"

    def test_argv_omits_branch_without_revision(self) -> None:
        """Given no revision, the argv has no --branch flag."""
        argv = self._build()

        assert "--branch" not in argv

    def test_argv_selects_shallow_clone_only_when_requested(self) -> None:
        """Given shallow selection, the argv adds --depth 1."""
        argv = self._build(CloneOptions(shallow=True))

        assert "--depth" in argv
        assert argv[argv.index("--depth") + 1] == "1"

    def test_argv_omits_depth_without_shallow_selection(self) -> None:
        """Given no shallow selection, the argv has no --depth flag."""
        argv = self._build()

        assert "--depth" not in argv

    def test_argv_orders_branch_before_depth(self) -> None:
        """Given both options, flags precede the URL in a stable order."""
        argv = self._build(CloneOptions(revision="main", shallow=True))

        assert argv == (
            "git",
            "clone",
            "--progress",
            "--branch",
            "main",
            "--depth",
            "1",
            "https://huggingface.co/author/model",
            "C:\\work\\model",
        )

    def test_argv_accepts_custom_git_command(self) -> None:
        """Given a custom command prefix, the argv prepends it verbatim."""
        argv = build_clone_argv(
            "https://huggingface.co/author/model",
            Path("dest"),
            git_command=("python", "C:\\fake\\git.py"),
        )

        assert argv[:2] == ("python", "C:\\fake\\git.py")
        assert argv[2] == "clone"

    def test_argv_passes_shell_metacharacters_literally(self) -> None:
        """Given shell metacharacters in a path, they survive as one token."""
        argv = build_clone_argv(
            "https://huggingface.co/author/model",
            Path("C:\\work\\dest & model; rm -rf"),
        )

        assert argv[-1] == "C:\\work\\dest & model; rm -rf"
        assert len(argv) == 5


class TestCloneEnvironment:
    """The clone environment forces stable, non-interactive Git stderr."""

    def test_environment_sets_stable_progress_and_locale(self) -> None:
        """Given a base mapping, the clone env fixes locale and progress."""
        base = {"PATH": "C:\\bin", "LANG": "zh_CN.UTF-8"}

        env = clone_environment(base)

        assert env["LC_ALL"] == "C"
        assert env["GIT_PROGRESS_DELAY"] == "0"
        assert env["GIT_TERMINAL_PROMPT"] == "0"
        assert env["PATH"] == "C:\\bin"
        assert env["LANG"] == "zh_CN.UTF-8"

    def test_environment_does_not_mutate_input(self) -> None:
        """Given a base mapping, the clone env leaves it untouched."""
        base = {"PATH": "C:\\bin"}

        _ = clone_environment(base)

        assert base == {"PATH": "C:\\bin"}
