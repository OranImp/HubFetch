"""Tests for read-only credential helper and Git Credential Manager assessment."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

import pytest

from hubfetch.diagnostics.credential_helpers import (
    CredentialCheckerOptions,
    CredentialHelperChecker,
    CredentialHelperState,
    GcmState,
)
from hubfetch.git.process_runner import run_command
from tests.diagnostics.conftest import (
    HELPER_FAIL_HANDLER,
    HELPER_MANAGER_HANDLER,
    HELPER_NONE_HANDLER,
    HELPER_STORE_HANDLER,
    make_credential_options,
    read_recorded_argv,
    write_fake_git,
)

if TYPE_CHECKING:
    from pathlib import Path


def test_safe_manager_helper_is_reported_safe(tmp_path: Path) -> None:
    """Given a manager helper configured, the report is safe without a warning."""
    script, behavior = write_fake_git(tmp_path, handlers=(HELPER_MANAGER_HANDLER,))

    report = CredentialHelperChecker(make_credential_options(script, behavior)).check()

    assert report.state is CredentialHelperState.SAFE
    assert tuple((entry.value, entry.origin) for entry in report.helpers) == (
        ("manager", "file:/etc/gitconfig"),
    )
    assert report.warning is None


def test_plaintext_store_helper_is_flagged_unsafe(tmp_path: Path) -> None:
    """Given a plaintext store helper, the report is flagged unsafe."""
    script, behavior = write_fake_git(tmp_path, handlers=(HELPER_STORE_HANDLER,))

    report = CredentialHelperChecker(make_credential_options(script, behavior)).check()

    assert report.state is CredentialHelperState.PLAINTEXT_UNSAFE
    assert report.helpers[0].value == "store"
    assert report.warning is not None
    assert "store" in report.warning
    assert report.guidance


def test_no_helper_is_reported(tmp_path: Path) -> None:
    """Given no configured helper, the report is none without a warning."""
    script, behavior = write_fake_git(tmp_path, handlers=(HELPER_NONE_HANDLER,))

    report = CredentialHelperChecker(make_credential_options(script, behavior)).check()

    assert report.state is CredentialHelperState.NONE
    assert report.helpers == ()
    assert report.warning is None


def test_helper_probe_failure_is_unknown(tmp_path: Path) -> None:
    """Given a failing config probe, the helper state is unknown."""
    script, behavior = write_fake_git(tmp_path, handlers=(HELPER_FAIL_HANDLER,))

    report = CredentialHelperChecker(make_credential_options(script, behavior)).check()

    assert report.state is CredentialHelperState.UNKNOWN


def test_git_missing_helper_probe_is_unknown(tmp_path: Path) -> None:
    """Given git cannot launch, the helper state is unknown."""
    missing = tmp_path / "does-not-exist-git.exe"
    options = CredentialCheckerOptions(
        git_command=(str(missing),),
        timeout_seconds=0.5,
        gcm_candidates=("nonexistent-gcm-xyz",),
    )

    report = CredentialHelperChecker(options).check()

    assert report.state is CredentialHelperState.UNKNOWN


def test_gcm_present_with_semantic_version(tmp_path: Path) -> None:
    """Given a GCM executable, presence and semantic version are captured."""
    gcm_script = tmp_path / "fake_gcm.py"
    _ = gcm_script.write_text(
        "import sys\nprint('Git Credential Manager version 2.6.0')\n",
        encoding="utf-8",
    )
    script, behavior = write_fake_git(tmp_path, handlers=(HELPER_MANAGER_HANDLER,))
    options = make_credential_options(
        script,
        behavior,
        gcm_candidates=(str(gcm_script),),
        gcm_probe_command=(sys.executable, str(gcm_script)),
    )

    report = CredentialHelperChecker(options).check()

    assert report.gcm.state is GcmState.PRESENT
    assert report.gcm.executable == str(gcm_script)
    assert report.gcm.version == "2.6.0"


def test_gcm_missing_is_reported(tmp_path: Path) -> None:
    """Given no GCM executable resolves, the report is missing."""
    script, behavior = write_fake_git(tmp_path, handlers=(HELPER_MANAGER_HANDLER,))
    options = make_credential_options(
        script, behavior, gcm_candidates=("nonexistent-gcm-xyz",)
    )

    report = CredentialHelperChecker(options).check()

    assert report.gcm.state is GcmState.MISSING
    assert report.gcm.executable is None
    assert report.gcm.version is None


def test_gcm_version_timeout_keeps_presence(tmp_path: Path) -> None:
    """Given a hanging GCM version probe, presence stays but version is None."""
    hanging = tmp_path / "hanging_gcm.py"
    _ = hanging.write_text("import time\ntime.sleep(5)\n", encoding="utf-8")
    script, behavior = write_fake_git(tmp_path, handlers=(HELPER_MANAGER_HANDLER,))
    options = make_credential_options(
        script,
        behavior,
        gcm_candidates=(str(hanging),),
        gcm_probe_command=(sys.executable, str(hanging)),
        timeout_seconds=0.3,
    )

    report = CredentialHelperChecker(options).check()

    assert report.gcm.state is GcmState.PRESENT
    assert report.gcm.version is None


def test_helper_probe_command_is_read_only(tmp_path: Path) -> None:
    """Given a full check, only the read-only config probe is invoked."""
    record = tmp_path / "argv.log"
    script, behavior = write_fake_git(
        tmp_path,
        handlers=(HELPER_MANAGER_HANDLER,),
        record=record,
    )
    options = make_credential_options(
        script, behavior, gcm_candidates=("nonexistent-gcm-xyz",)
    )

    _ = CredentialHelperChecker(options).check()

    assert read_recorded_argv(record) == (
        ("config", "--show-origin", "--get-all", "credential.helper"),
    )


@pytest.mark.windows
@pytest.mark.integration
def test_real_credential_helpers_are_typed_and_read_only() -> None:
    """Given the real system Git, credential helpers are typed and read-only."""
    before = run_command(("git", "config", "--list", "--show-origin")).stdout
    report = CredentialHelperChecker().check()
    after = run_command(("git", "config", "--list", "--show-origin")).stdout

    assert report.state in {
        CredentialHelperState.SAFE,
        CredentialHelperState.PLAINTEXT_UNSAFE,
        CredentialHelperState.NONE,
        CredentialHelperState.UNKNOWN,
    }
    assert report.gcm.state in {GcmState.PRESENT, GcmState.MISSING}
    if report.gcm.state is GcmState.PRESENT:
        assert report.gcm.executable is not None
    assert after == before
