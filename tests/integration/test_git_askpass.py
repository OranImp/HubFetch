"""Real-system integration tests for the Git AskPass app-token boundary.

A local HTTP server serves a bare repository over dumb HTTP behind Basic
authentication. The first Windows-only test clones it through real system Git
with ``GIT_ASKPASS`` pointing at the actual AskPass entry point launcher and a
real Windows Credential Manager credential: the helper answers the username
and password prompts exactly, the server observes the expected
``hf_user:<token>`` Basic header, the clone materializes, and recursive
sentinel scans over the captured argv/environment/logs/evidence stay clean.
The second test proves the default (SYSTEM) policy wires nothing into Git and
the same challenge fails closed instead of prompting.
"""

from __future__ import annotations

import base64
import os
import subprocess
from typing import TYPE_CHECKING

import pytest

from hubfetch.git.auth_policy import ASKPASS_ALIAS_VARIABLE
from hubfetch.security.redaction import REDACTED
from tests.conftest import HF_TEST_SECRET
from tests.helpers.evidence import capture_process_command
from tests.integration.git_askpass_fixtures import (
    LAUNCHER_SOURCE,
    auth_git_server,
    bare_repository,
    git_environment,
    launcher,
    real_credential,
    recursive_bytes,
    remove_force,
    system_git,
)

if TYPE_CHECKING:
    from pathlib import Path

    from tests.helpers.evidence import ProcessCommandSnapshot


@pytest.mark.windows
@pytest.mark.integration
def test_app_token_askpass_resolves_through_real_git(tmp_path: Path) -> None:
    """Given an app-token credential, system Git clones through the helper."""
    root = tmp_path / "run"
    root.mkdir()
    try:
        bare = bare_repository(parent=root)
        log = root / "askpass.log"
        helper = launcher(root=root)
        with (
            real_credential(HF_TEST_SECRET) as alias,
            auth_git_server(bare=bare, secret=HF_TEST_SECRET) as server,
        ):
            env = git_environment(
                dict(os.environ),
                launcher=helper,
                log=log,
                alias=alias,
            )
            snapshot: ProcessCommandSnapshot = capture_process_command(
                ["git", "clone", server.url, str(root / "dest")], environment=env
            )
            destination = root / "dest"
            result = subprocess.run(  # noqa: S603
                [system_git(), "clone", server.url, str(destination)],
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )

            assert result.returncode == 0
            assert (destination / "README.md").is_file()
            assert (destination / "data.bin").is_file()
            assert (destination / ".git").is_dir()
            expected_auth = (
                "Basic "
                + base64.b64encode(f"hf_user:{HF_TEST_SECRET}".encode()).decode()
            )
            assert len(server.observed_auth) >= 1
            assert all(received == expected_auth for received in server.observed_auth)
            assert "git" in snapshot.argv
            assert HF_TEST_SECRET.encode() not in recursive_bytes(root)
            assert HF_TEST_SECRET not in (env.get(ASKPASS_ALIAS_VARIABLE) or "")
            assert HF_TEST_SECRET not in result.stdout
            assert HF_TEST_SECRET not in result.stderr
    finally:
        remove_force(tmp_path / "run")


@pytest.mark.windows
@pytest.mark.integration
def test_default_policy_leaves_git_untouched_and_fails_closed(
    tmp_path: Path,
) -> None:
    """Given the default policy, Git has no helper wired and fails closed."""
    root = tmp_path / "run"
    root.mkdir()
    try:
        bare = bare_repository(parent=root)
        log = root / "askpass.log"
        helper = launcher(root=root)
        with auth_git_server(bare=bare, secret=HF_TEST_SECRET) as server:
            env = git_environment(
                dict(os.environ),
                launcher=helper,
                log=log,
                alias=None,
                isolate_helpers=True,
            )

            assert "GIT_ASKPASS" not in env
            assert "SSH_ASKPASS" not in env
            assert ASKPASS_ALIAS_VARIABLE not in env
            assert env.get("GCM_INTERACTIVE") is None

            env["GIT_TERMINAL_PROMPT"] = "0"
            result = subprocess.run(  # noqa: S603
                [system_git(), "ls-remote", server.url],
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )

            assert result.returncode != 0
            assert "could not read Username" in result.stderr
            assert "Username" in result.stderr
            assert server.observed_auth == []
            assert HF_TEST_SECRET.encode() not in recursive_bytes(root)
            assert HF_TEST_SECRET not in result.stdout
            assert HF_TEST_SECRET not in result.stderr
            assert REDACTED not in env
    finally:
        remove_force(tmp_path / "run")


def test_launcher_is_pure_ascii_and_forwarding_only() -> None:
    """Given the launcher source, no path or secret is embedded in it."""
    assert LAUNCHER_SOURCE.isascii()
    assert HF_TEST_SECRET not in LAUNCHER_SOURCE
    assert LAUNCHER_SOURCE.startswith("@echo off")
    assert "%PYTHON%" in LAUNCHER_SOURCE
