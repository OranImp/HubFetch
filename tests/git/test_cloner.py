"""Tests for the Git cloner: preflight, streaming progress, and preservation.

A fake ``git`` executable driven by a JSON behavior payload proves readiness
probing, no-shell argv passthrough, typed progress records, cancellation with
partial preservation, and non-empty destination refusal. The
stderr-to-category error mapping lives in ``test_cloner_errors.py``.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Final

import pytest

from hubfetch.domain.errors import (
    CancellationError,
    DependencyError,
    DiskError,
    NetworkError,
)
from hubfetch.git.clone_command import CloneOptions
from hubfetch.git.cloner import GitCloner
from hubfetch.git.progress import ProgressPhase
from tests.git.conftest import VERSION_HANDLER, FakeGitHandler, read_recorded_argv

if TYPE_CHECKING:
    from pathlib import Path

FakeGitBuilder = Callable[..., tuple[tuple[str, ...], dict[str, str]]]
"""Signature of the ``fake_git`` fixture builder in the tests git conftest."""

URL: Final = "https://huggingface.co/author/model"


class TestCloneSuccess:
    """A successful clone streams typed progress to the destination."""

    def test_clone_parses_progress_into_typed_phases(
        self, tmp_path: Path, fake_git: FakeGitBuilder
    ) -> None:
        """Given a successful clone, records carry the documented phases."""
        destination = tmp_path / "dest"
        handler = FakeGitHandler(
            match=("clone",),
            stderr=(
                ("remote: Enumerating objects: 3, done.\n", 0.0),
                ("remote: Counting objects: 100% (3/3), done.\n", 0.0),
                ("Receiving objects: 100% (3/3), done.\n", 0.0),
                ("Updating files: 100% (3/3), done.\n", 0.0),
            ),
        )
        command, environment = fake_git([VERSION_HANDLER, handler])
        cloner = GitCloner(git_command=command, environment=environment)

        outcome = cloner.clone(URL, destination)

        assert [record.phase for record in outcome.records] == [
            ProgressPhase.ENUMERATING,
            ProgressPhase.COUNTING,
            ProgressPhase.RECEIVING,
            ProgressPhase.UPDATING,
        ]
        assert outcome.diagnostics == ()
        assert destination.is_dir()

    def test_clone_reports_each_record_to_progress_callback(
        self, tmp_path: Path, fake_git: FakeGitBuilder
    ) -> None:
        """Given a progress callback, it receives each parsed record in order."""
        destination = tmp_path / "dest"
        handler = FakeGitHandler(
            match=("clone",),
            stderr=(
                ("Receiving objects: 50% (2/4)\n", 0.0),
                ("Receiving objects: 100% (4/4), done.\n", 0.0),
            ),
        )
        command, environment = fake_git([VERSION_HANDLER, handler])
        cloner = GitCloner(git_command=command, environment=environment)
        received: list[object] = []

        outcome = cloner.clone(URL, destination, on_progress=received.append)

        assert received == list(outcome.records)


class TestCloneArgvPassthrough:
    """The cloner passes the exact typed argv to the git executable."""

    def test_clone_passes_branch_and_depth_options(
        self, tmp_path: Path, fake_git: FakeGitBuilder
    ) -> None:
        """Given revision and shallow options, the recorded argv carries them."""
        destination = tmp_path / "dest"
        record = tmp_path / "argv.txt"
        handler = FakeGitHandler(match=("clone",), record=record)
        command, environment = fake_git([VERSION_HANDLER, handler])
        cloner = GitCloner(git_command=command, environment=environment)

        _ = cloner.clone(
            URL,
            destination,
            CloneOptions(revision="v1.0", shallow=True),
        )

        assert read_recorded_argv(record) == (
            (
                "clone",
                "--progress",
                "--branch",
                "v1.0",
                "--depth",
                "1",
                URL,
                str(destination),
            ),
        )

    def test_clone_does_not_use_a_shell(
        self, tmp_path: Path, fake_git: FakeGitBuilder
    ) -> None:
        """Given shell metacharacters, they reach git as one literal token."""
        destination = tmp_path / "dest; rm -rf ."
        record = tmp_path / "argv.txt"
        handler = FakeGitHandler(match=("clone",), record=record)
        command, environment = fake_git([VERSION_HANDLER, handler])
        cloner = GitCloner(git_command=command, environment=environment)

        _ = cloner.clone(URL, destination)

        argv = read_recorded_argv(record)
        assert argv[0][-1] == str(destination)
        assert len(argv[0]) == 4


class TestClonePreflight:
    """Destination and dependency preflight gates the clone invocation."""

    def test_preflight_requires_installed_git(
        self, tmp_path: Path, fake_git: FakeGitBuilder
    ) -> None:
        """Given a broken git probe, the clone fails with a dependency error."""
        command, environment = fake_git([], fallback_exit=1)
        cloner = GitCloner(git_command=command, environment=environment)

        with pytest.raises(DependencyError):
            _ = cloner.clone(URL, tmp_path / "dest")

    def test_preflight_rejects_non_empty_destination_without_invoking_git(
        self, tmp_path: Path, fake_git: FakeGitBuilder
    ) -> None:
        """Given a non-empty destination, the clone is refused before git runs."""
        destination = tmp_path / "dest"
        destination.mkdir()
        _ = (destination / "existing.txt").write_text("x", encoding="utf-8")
        record = tmp_path / "argv.txt"
        handler = FakeGitHandler(match=("clone",), record=record)
        command, environment = fake_git([VERSION_HANDLER, handler])
        cloner = GitCloner(git_command=command, environment=environment)

        with pytest.raises(DiskError):
            _ = cloner.clone(URL, destination)

        assert not record.exists()

    def test_preflight_rejects_destination_that_is_a_file(
        self, tmp_path: Path, fake_git: FakeGitBuilder
    ) -> None:
        """Given a destination that is a file, the clone is refused."""
        destination = tmp_path / "dest"
        _ = destination.write_text("x", encoding="utf-8")
        command, environment = fake_git([VERSION_HANDLER])
        cloner = GitCloner(git_command=command, environment=environment)

        with pytest.raises(DiskError):
            _ = cloner.clone(URL, destination)


class TestCloneFailurePreservation:
    """A failed or cancelled clone never cleans the partial destination."""

    def test_failure_preserves_partial_destination(
        self, tmp_path: Path, fake_git: FakeGitBuilder
    ) -> None:
        """Given a failing clone, the partial directory survives untouched."""
        destination = tmp_path / "dest"
        handler = FakeGitHandler(
            match=("clone",),
            stderr=(
                (("fatal: unable to access 'https://huggingface.co/x': boom\n"), 0.0),
            ),
            exit_code=128,
            destination=destination,
        )
        command, environment = fake_git([VERSION_HANDLER, handler])
        cloner = GitCloner(git_command=command, environment=environment)

        with pytest.raises(NetworkError):
            _ = cloner.clone(URL, destination)

        assert (destination / "partial-file.txt").is_file()

    def test_retry_to_same_partial_path_is_refused(
        self, tmp_path: Path, fake_git: FakeGitBuilder
    ) -> None:
        """Given a failed clone, a retry to the same path refuses without cleanup."""
        destination = tmp_path / "dest"
        handler = FakeGitHandler(
            match=("clone",),
            stderr=(
                (("fatal: unable to access 'https://huggingface.co/x': boom\n"), 0.0),
            ),
            exit_code=128,
            destination=destination,
        )
        command, environment = fake_git([VERSION_HANDLER, handler])
        cloner = GitCloner(git_command=command, environment=environment)

        with pytest.raises(NetworkError):
            _ = cloner.clone(URL, destination)
        with pytest.raises(DiskError):
            _ = cloner.clone(URL, destination)

        assert (destination / "partial-file.txt").is_file()

    def test_cancellation_interrupts_and_preserves_partial(
        self, tmp_path: Path, fake_git: FakeGitBuilder
    ) -> None:
        """Given a cooperative cancel, the run stops and keeps the partial tree."""
        destination = tmp_path / "dest"
        log = tmp_path / "git.log"
        handler = FakeGitHandler(
            match=("clone",),
            stderr=(
                ("first progress line\n", 1.0),
                ("second progress line\n", 1.0),
                ("third progress line\n", 1.0),
            ),
            destination=destination,
            log=log,
        )
        command, environment = fake_git([VERSION_HANDLER, handler])
        cloner = GitCloner(git_command=command, environment=environment)
        calls = 0

        def cancel() -> bool:
            nonlocal calls
            calls += 1
            return calls >= 2

        with pytest.raises(CancellationError):
            _ = cloner.clone(URL, destination, cancel=cancel)

        lines = log.read_text(encoding="utf-8").splitlines()
        assert lines[0] == "start"
        assert "end" not in lines
        assert (destination / "partial-file.txt").is_file()
