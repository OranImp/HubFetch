# noqa: SIZE_OK - one module must enumerate the whole diagnostics-surface
# contract: categorized probes, recheck, install-guidance copy, keyring failure,
# support-bundle export seams, and denied-export error surfacing.

"""Given/When/Then contracts for the Diagnostics work surface.

Todo 27's Diagnostics surface composes read-only storage, network, Git,
Git-Xet, credential-helper, keyring, endpoint, and application probes into one
categorized report. Recheck re-runs every probe; install guidance is copyable
display data; support-bundle export is user-selected and fail-closed on a
denied or invalid path.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from hubfetch.config.settings import Locale, Settings
from hubfetch.credentials.models import BackendIdentity
from hubfetch.credentials.port import CredentialBackendRejectedError
from hubfetch.diagnostics.credential_helpers import (
    CredentialHelperEntry,
    CredentialHelperReport,
    CredentialHelperState,
    GcmReport,
    GcmState,
)
from hubfetch.diagnostics.git import (
    DependencyState,
    GitDependencyReport,
    ToolProbeState,
    XetProbe,
    XetState,
)
from hubfetch.diagnostics.support_bundle import (
    SupportBundleError,
    SupportBundleResult,
)
from hubfetch.ui.diagnostics.view import (
    DiagnosticsOptions,
    DiagnosticsView,
    DiagnosticsViewTexts,
    EndpointProbe,
)

if TYPE_CHECKING:
    from pathlib import Path

    from pytestqt.qtbot import QtBot


@dataclass(frozen=True, slots=True)
class FakeGitChecker:
    """One read-only Git checker returning a fixed ready report."""

    report: GitDependencyReport

    def check(self) -> GitDependencyReport:
        """Return the fixed report; Recheck is just another call."""
        return self.report


@dataclass(frozen=True, slots=True)
class FakeCredentialChecker:
    """One read-only credential checker returning a fixed safe report."""

    report: CredentialHelperReport

    def check(self) -> CredentialHelperReport:
        """Return the fixed report; Recheck is just another call."""
        return self.report


class FakeClipboard:
    """Records the text handed to a clipboard sink."""

    text_value: str = ""

    def setText(self, text: str) -> None:  # noqa: N802 - Qt API naming
        """Store the copied text."""
        self.text_value = text


def _ready_git_report() -> GitDependencyReport:
    """Build one fully ready Git/Git-Xet dependency report."""
    return GitDependencyReport(
        git_state=ToolProbeState.INSTALLED,
        git_version="2.54.0.windows.1",
        xet=XetProbe(
            state=XetState.CONFIGURED,
            version="0.2.1",
            filters=(),
            detail="configured",
        ),
        state=DependencyState.READY,
        guidance=(),
    )


def _safe_credential_report() -> CredentialHelperReport:
    """Build one safe credential helper report with GCM present."""
    return CredentialHelperReport(
        state=CredentialHelperState.SAFE,
        helpers=(CredentialHelperEntry(value="manager", origin="file:/etc/gitconfig"),),
        gcm=GcmReport(state=GcmState.PRESENT, executable="gcm.exe", version="2.5.0"),
        warning=None,
        guidance=(),
    )


def _untrusted_keyring_provider() -> BackendIdentity:
    """Simulate the fail-closed startup rejection of an unsafe keyring backend."""
    raise CredentialBackendRejectedError(
        reason="keyring.backends.null.NullKeyring stores no durable credential"
    )


def _make_view(
    qtbot: QtBot,
    *,
    settings: Settings | None = None,
    options: DiagnosticsOptions | None = None,
) -> DiagnosticsView:
    """Build a diagnostics view with injected deterministic probe seams."""
    view = DiagnosticsView(
        DiagnosticsViewTexts.for_locale(Locale.ZH_CN),
        settings=settings if settings is not None else Settings(),
        options=options,
    )
    qtbot.addWidget(view)
    return view


def _ready_options() -> DiagnosticsOptions:
    """Return probe options that deterministically report every category ready."""
    return DiagnosticsOptions(
        git_checker=FakeGitChecker(_ready_git_report()).check,
        credential_checker=FakeCredentialChecker(_safe_credential_report()).check,
        keyring_provider=lambda: BackendIdentity(
            module="keyring.backends.Windows", class_name="WinVaultKeyring"
        ),
        endpoint_probe=lambda: EndpointProbe(
            url="https://huggingface.co", reachable=True, detail="HTTP 200"
        ),
    )


def test_recheck_runs_probes_and_renders_every_category(qtbot: QtBot) -> None:
    """Given fake ready probes, When rechecking, Then the report carries all
    seven categorized diagnostic groups."""
    view = _make_view(qtbot, options=_ready_options())

    report = view.recheck()

    keys = {category.key for category in report.categories}
    assert keys == {
        "storage",
        "network",
        "git",
        "credentials",
        "keyring",
        "endpoint",
        "application",
    }
    git_category = next(
        category for category in report.categories if category.key == "git"
    )
    assert git_category.entries[0].value == "2.54.0.windows.1"


def test_install_guidance_contains_copyable_winget_commands(qtbot: QtBot) -> None:
    """Given a degraded Git/Xet environment, When reading guidance, Then the
    copyable text names both non-elevated winget commands."""
    view = _make_view(qtbot)

    guidance = view.install_guidance_text()

    assert "winget install --id Git.Git -e" in guidance
    assert "winget install --id git-xet.git-xet -e" in guidance
    assert "git xet install" in guidance


def test_copy_install_guidance_writes_to_clipboard(qtbot: QtBot) -> None:
    """Given the copy command, When fired, Then the full guidance text lands in
    the supplied clipboard sink."""
    view = _make_view(qtbot)
    clipboard = FakeClipboard()

    copied = view.copy_install_guidance(clipboard=clipboard)

    assert copied == clipboard.text_value
    assert "winget install --id Git.Git -e" in clipboard.text_value


def test_untrusted_keyring_is_reported_degraded(qtbot: QtBot) -> None:
    """Given an untrusted keyring backend, When rechecking, Then the keyring
    category reports a typed degraded state without raising."""
    view = _make_view(
        qtbot,
        options=DiagnosticsOptions(
            git_checker=FakeGitChecker(_ready_git_report()).check,
            credential_checker=FakeCredentialChecker(_safe_credential_report()).check,
            keyring_provider=_untrusted_keyring_provider,
            endpoint_probe=lambda: EndpointProbe(
                url="https://huggingface.co", reachable=True, detail="HTTP 200"
            ),
        ),
    )

    report = view.recheck()

    keyring = next(
        category for category in report.categories if category.key == "keyring"
    )
    assert "rejected" in keyring.entries[0].value


def test_support_export_uses_user_selected_path(qtbot: QtBot, tmp_path: Path) -> None:
    """Given a selected export path, When exporting, Then the exporter receives
    exactly that path and the typed result is surfaced."""
    target = tmp_path / "user-selected" / "support.zip"
    exported: list[Path] = []
    result = SupportBundleResult(
        target=target,
        member_count=3,
        bytes_written=1024,
        log_members=("logs/app.jsonl",),
        errors=(),
    )

    def fake_exporter(path: Path) -> SupportBundleResult:
        exported.append(path)
        return result

    view = _make_view(
        qtbot,
        options=DiagnosticsOptions(exporter=fake_exporter, path_dialog=lambda: target),
    )

    outcome = view.export_support_bundle()

    assert exported == [target]
    assert outcome is result
    assert view.export_error() is None


def test_denied_export_path_surfaces_typed_error(qtbot: QtBot, tmp_path: Path) -> None:
    """Given an exporter that fails fail-closed, When exporting, Then a typed
    error is surfaced in the view without raising."""
    target = tmp_path / "denied" / "support.zip"

    def failing_exporter(path: Path) -> SupportBundleResult:
        raise SupportBundleError(reason=f"cannot write {path}")

    view = _make_view(
        qtbot,
        options=DiagnosticsOptions(
            exporter=failing_exporter, path_dialog=lambda: target
        ),
    )

    outcome = view.export_support_bundle()

    assert outcome is None
    error = view.export_error()
    assert error is not None
    assert "cannot write" in error


def test_cancelled_export_dialog_does_nothing(qtbot: QtBot) -> None:
    """Given a cancelled path dialog, When exporting, Then no exporter runs and
    no error is surfaced."""
    must_not_run = "exporter must not run after cancel"

    def unused_exporter(_path: Path) -> SupportBundleResult:
        raise AssertionError(must_not_run)

    view = _make_view(
        qtbot,
        options=DiagnosticsOptions(exporter=unused_exporter, path_dialog=lambda: None),
    )

    outcome = view.export_support_bundle()

    assert outcome is None
    assert view.export_error() is None


def test_recheck_button_refreshes_report(qtbot: QtBot) -> None:
    """Given one report and a new checker state, When the Recheck button fires,
    Then the view owns the newer report."""
    calls: list[int] = []

    def counting_checker() -> GitDependencyReport:
        calls.append(len(calls))
        return _ready_git_report()

    view = _make_view(
        qtbot,
        options=DiagnosticsOptions(
            git_checker=counting_checker,
            credential_checker=FakeCredentialChecker(_safe_credential_report()).check,
            keyring_provider=lambda: BackendIdentity(
                module="keyring.backends.Windows", class_name="WinVaultKeyring"
            ),
            endpoint_probe=lambda: EndpointProbe(
                url="https://huggingface.co", reachable=True, detail="HTTP 200"
            ),
        ),
    )
    _ = view.recheck()

    view.recheck_button().click()

    assert calls == [0, 1]
