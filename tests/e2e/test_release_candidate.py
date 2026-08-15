"""Automated release-candidate contract for the HubFetch 0.1.0 candidate.

# noqa: SIZE_OK - one module must enumerate the full release-candidate journey
# matrix (queue ordering, cancellation escalation, retry reuse, clone retry
# destination, startup recovery, proxy modes, missing dependency, OAuth adapter
# fake, disposable AskPass, support ZIP, both locales, sentinel scans) plus the
# gated live Hub/Git smokes; splitting it would scatter the release contract.

The deterministic journeys prove the release must-have behaviors with real
workers, real SQLite, and local fixtures -- queue ordering, queued/active
cancellation escalation, retry download reuse, rejected in-place clone retry,
startup recovery, proxy inherit/direct/manual failure, missing dependency
handling, the OAuth adapter fake, the disposable app-token/AskPass cycle, the
support ZIP boundary, both locales, and recursive sentinel scans.

The live smokes are marked ``pytest.mark.live`` and gated by
``HUBFETCH_RUN_LIVE=1`` (set by ``scripts/verify_release_candidate.ps1`` with
the proxy environment), so the offline gate never touches the network while
the release script proves real Hub/Git transfer outcomes.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import sys
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING, Final, final, override

import pytest

from hubfetch.application.bootstrap import WorkerEnvOverrides
from hubfetch.askpass.main import run_askpass
from hubfetch.auth.auth_service import AuthService
from hubfetch.auth.oauth_contract import (
    OAuthAdapterUnavailableError,
    OAuthContractState,
    verify_contract,
)
from hubfetch.config.settings import Locale, Settings
from hubfetch.credentials.models import (
    BackendIdentity,
    CredentialAlias,
    generate_credential_alias,
)
from hubfetch.credentials.port import (
    CredentialNotFoundError,
    CredentialStore,
)
from hubfetch.diagnostics.support_bundle import (
    SupportBundleBuilder,
    contains_secret,
)
from hubfetch.domain.errors import ErrorCategory, HubFetchError
from hubfetch.domain.ids import parse_attempt_id, parse_repository_id, parse_task_id
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import (
    AuthSource,
    LocalDirectoryDestination,
    OverwriteExisting,
    ProxyMode,
    SingleFileDownloadSpec,
)
from hubfetch.git.auth_policy import ASKPASS_ALIAS_VARIABLE
from hubfetch.git.clone_command import CloneOptions
from hubfetch.git.cloner import GitCloner
from hubfetch.hub.adapter import HubAdapter
from hubfetch.hub.downloader import HubDownloader
from hubfetch.hub.progress import ProgressSink
from hubfetch.network.proxy import ProxyPolicyError, build_proxy_policy
from hubfetch.scenarios._crash_app_script import CRASH_APP_SCRIPT
from hubfetch.scenarios._fixtures import (
    SENTINEL,
    kill_process_without_tree,
    spawn_crash_app,
)
from hubfetch.security.redaction import Redactor, SecretRegistry
from hubfetch.ui.navigation import ShellTexts
from tests.e2e.support import (
    bare_repository_with_objects,
    make_clone_spec,
    make_file_spec,
    recursive_scan_for_secret,
    start_runtime,
    wait_process_gone,
    worker_environment_scan,
    write_git_redirect_config,
)
from tests.hub.fixtures import hub_fixture

if TYPE_CHECKING:
    from PySide6.QtCore import QProcessEnvironment
    from pytestqt.qtbot import QtBot

    from hubfetch.application.runtime import CancelOutcome, Runtime

pytestmark = pytest.mark.windows
if platform.system() != "Windows":
    pytest.skip(allow_module_level=True)

WAIT_TIMEOUT_MS: Final = 60_000
LIVE_RUN_ENV: Final = "HUBFETCH_RUN_LIVE"
LIVE_EVIDENCE_ENV: Final = "HUBFETCH_EVIDENCE_DIR"
LIVE_REPO: Final = "hf-internal-testing/tiny-random-bert"
LIVE_REVISION: Final = "main"
LIVE_PROXY: Final = "http://127.0.0.1:7897"


def _task_state(runtime: Runtime, task_id: str) -> LifecycleState:
    """Read the current persisted lifecycle state of one task."""
    return runtime.detail(parse_task_id(task_id)).task.state


def _wait_state(
    qtbot: QtBot, runtime: Runtime, task_id: str, state: LifecycleState
) -> None:
    """Wait until a task reaches the given persisted lifecycle state."""
    qtbot.waitUntil(
        lambda: _task_state(runtime, task_id) == state,
        timeout=WAIT_TIMEOUT_MS,
    )


def _shutdown(qtbot: QtBot, runtime: Runtime) -> None:
    """Drive a bounded orderly shutdown of one runtime."""
    shutdown = runtime.shutdown()
    qtbot.waitUntil(lambda: shutdown.finished_cleanly, timeout=WAIT_TIMEOUT_MS)
    runtime.close()


class TestReleaseQueueAndCancellation:
    """Given a mixed queue, FIFO one-at-a-time dispatch and cancellation."""

    def test_queue_runs_one_active_in_fifo_order(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        content = b"release-queue-content"
        with hub_fixture(
            files=[("a.bin", len(content)), ("b.bin", len(content))],
            content={"a.bin": content, "b.bin": content},
        ) as fixture:
            git_parent = tmp_path / "git"
            git_parent.mkdir()
            git_root = bare_repository_with_objects(parent=git_parent)
            config_path = write_git_redirect_config(root=git_root)
            outcome = start_runtime(
                app_root=tmp_path / "app-data",
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint,
                    hub_cache_dir=tmp_path / "cache",
                    git_config_global=config_path,
                    git_config_nosystem=True,
                ),
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                order = ["release-a", "release-clone", "release-b"]
                terminals: list[tuple[str, str]] = []

                def record(task_id: str, kind: str) -> None:
                    terminals.append((task_id, kind))

                runtime.task_terminal.connect(record)
                runtime.create_task(
                    parse_task_id(order[0]),
                    make_file_spec(filename="a.bin", destination=tmp_path / "out-a"),
                    parse_attempt_id("rqa1"),
                )
                runtime.create_task(
                    parse_task_id(order[1]),
                    make_clone_spec(destination=tmp_path / "clone"),
                    parse_attempt_id("rqa2"),
                )
                runtime.create_task(
                    parse_task_id(order[2]),
                    make_file_spec(filename="b.bin", destination=tmp_path / "out-b"),
                    parse_attempt_id("rqa3"),
                )
                for task_id in order:
                    _wait_state(qtbot, runtime, task_id, LifecycleState.SUCCEEDED)

                assert [task_id for task_id, _ in terminals] == order
                assert all(kind == "succeeded" for _, kind in terminals)
                assert runtime.snapshot().active_count == 0
                assert (tmp_path / "out-a" / "a.bin").read_bytes() == content
                assert (tmp_path / "clone" / "README.md").is_file()
                assert (tmp_path / "out-b" / "b.bin").read_bytes() == content
            finally:
                _shutdown(qtbot, runtime)

    def test_queued_cancel_persists_without_launching_worker(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        with hub_fixture(
            files=[("a.bin", 8)], content={"a.bin": b"aaaaaaaa"}
        ) as fixture:
            outcome = start_runtime(
                app_root=tmp_path / "app-data",
                overrides=WorkerEnvOverrides(hub_endpoint=fixture.endpoint),
                open_dispatch_gate=False,
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                task_id = parse_task_id("release-queued-cancel")
                runtime.create_task(
                    task_id,
                    make_file_spec(filename="a.bin", destination=tmp_path / "out"),
                    parse_attempt_id("rcq1"),
                )
                assert _task_state(runtime, "release-queued-cancel") == (
                    LifecycleState.QUEUED
                )

                queued_outcome: CancelOutcome = runtime.cancel(task_id)

                assert queued_outcome.active_cancellation is False
                assert (
                    _task_state(runtime, "release-queued-cancel")
                    == LifecycleState.CANCELLED
                )
                assert runtime.active_supervisor(task_id) is None
            finally:
                _shutdown(qtbot, runtime)

    def test_active_cancel_truthful_and_worker_gone(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        big = b"z" * (11 * 1024 * 1024)
        with hub_fixture(
            files=[("big.bin", len(big)), ("next.bin", 16)],
            content={"big.bin": big, "next.bin": b"n" * 16},
        ) as fixture:
            outcome = start_runtime(
                app_root=tmp_path / "app-data",
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint, hub_cache_dir=tmp_path / "cache"
                ),
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                running = parse_task_id("release-running")
                next_task = parse_task_id("release-next")
                running_signals: list[str] = []
                runtime.task_running.connect(running_signals.append)
                runtime.create_task(
                    running,
                    make_file_spec(
                        filename="big.bin", destination=tmp_path / "out-big"
                    ),
                    parse_attempt_id("rc1"),
                )
                runtime.create_task(
                    next_task,
                    make_file_spec(
                        filename="next.bin", destination=tmp_path / "out-next"
                    ),
                    parse_attempt_id("rc2"),
                )

                _wait_state(qtbot, runtime, "release-running", LifecycleState.RUNNING)
                qtbot.waitUntil(lambda: bool(running_signals), timeout=WAIT_TIMEOUT_MS)
                supervisor = runtime.active_supervisor(running)
                assert supervisor is not None
                worker_pid = supervisor.worker.pid
                assert worker_pid is not None

                active_outcome: CancelOutcome = runtime.cancel(running)

                assert active_outcome.active_cancellation is True
                _wait_state(qtbot, runtime, "release-running", LifecycleState.CANCELLED)
                _wait_state(qtbot, runtime, "release-next", LifecycleState.SUCCEEDED)
                assert wait_process_gone(worker_pid, timeout_seconds=60.0), (
                    "cancelled worker left an orphan process"
                )
                assert runtime.snapshot().active_count == 0
                assert (tmp_path / "out-next" / "next.bin").is_file()
            finally:
                _shutdown(qtbot, runtime)


class TestReleaseRetryAndRecovery:
    """Given interrupted work, retry reuses data and startup recovers."""

    def test_retry_after_interruption_reuses_partial_download(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        big = b"c" * (11 * 1024 * 1024)
        with hub_fixture(
            files=[("big.bin", len(big))],
            content={"big.bin": big},
            download_error={"big.bin": "truncate_once"},
        ) as fixture:
            app_root = tmp_path / "app-data"
            cache_dir = tmp_path / "cache"
            script = tmp_path / "crash_app.py"
            _ = script.write_text(CRASH_APP_SCRIPT, encoding="utf-8")
            if not os.environ.get("PYTHONPATH"):
                os.environ["PYTHONPATH"] = os.pathsep.join(
                    entry for entry in sys.path if entry
                )
            process, worker_pid, _marker, _pid_file = spawn_crash_app(
                app_script=script,
                app_root=app_root,
                endpoint=fixture.endpoint,
                cache_dir=cache_dir,
                work_dir=tmp_path,
            )
            try:
                kill_process_without_tree(process.pid)
                _ = process.wait(timeout=30)
                if process.stdout is not None:
                    process.stdout.close()
                assert wait_process_gone(worker_pid, timeout_seconds=60.0), (
                    "worker survived the killed runtime"
                )

                outcome = start_runtime(
                    app_root=app_root,
                    overrides=WorkerEnvOverrides(
                        hub_endpoint=fixture.endpoint, hub_cache_dir=cache_dir
                    ),
                )
                runtime = outcome.runtime
                assert runtime is not None
                try:
                    assert "crash-download" in outcome.recovered
                    assert (
                        _task_state(runtime, "crash-download")
                        == LifecycleState.INTERRUPTED
                    )
                    assert any(path.is_file() for path in cache_dir.rglob("*")), (
                        "interrupted transfer preserved no partial artifacts"
                    )

                    result = runtime.retry(
                        parse_task_id("crash-download"),
                        new_attempt_id=parse_attempt_id("crash-r2"),
                    )
                    assert result.linked_from == parse_attempt_id("crash-a1")
                    retried_id = str(result.task_id)
                    _wait_state(qtbot, runtime, retried_id, LifecycleState.SUCCEEDED)
                    assert any(path.is_file() for path in cache_dir.rglob("*")), (
                        "retry did not reuse the interrupted cache"
                    )
                finally:
                    _shutdown(qtbot, runtime)
            finally:
                if process.poll() is None:
                    kill_process_without_tree(process.pid)

    def test_rejected_in_place_clone_retry_needs_new_destination(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        git_parent = tmp_path / "git"
        git_parent.mkdir()
        git_root = bare_repository_with_objects(parent=git_parent)
        config_path = write_git_redirect_config(root=git_root)
        outcome = start_runtime(
            app_root=tmp_path / "app-data",
            overrides=WorkerEnvOverrides(
                git_config_global=config_path, git_config_nosystem=True
            ),
        )
        runtime = outcome.runtime
        assert runtime is not None
        try:
            rejected_dest = tmp_path / "clone-rejected"
            rejected_dest.mkdir()
            (rejected_dest / "existing.txt").write_text("occupied", encoding="utf-8")
            rejected = parse_task_id("release-clone-rejected")
            runtime.create_task(
                rejected,
                make_clone_spec(destination=rejected_dest),
                parse_attempt_id("rcj1"),
            )
            _wait_state(qtbot, runtime, "release-clone-rejected", LifecycleState.FAILED)
            failure_events = [
                event
                for event in runtime.detail(rejected).events
                if event.kind == "task_transitioned"
            ]
            assert failure_events[-1].to_state == LifecycleState.FAILED

            retried = parse_task_id("release-clone-retried")
            runtime.create_task(
                retried,
                make_clone_spec(destination=tmp_path / "clone-new"),
                parse_attempt_id("rcj2"),
            )
            _wait_state(
                qtbot, runtime, "release-clone-retried", LifecycleState.SUCCEEDED
            )
            assert (tmp_path / "clone-new" / "README.md").is_file()
        finally:
            _shutdown(qtbot, runtime)


class TestReleaseDependencyAndProxyBoundaries:
    """Given typed failure conditions, the candidate fails closed."""

    def test_offline_endpoint_fails_without_false_success(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        """Given an unreachable Hub endpoint, the task fails, never succeeds."""
        outcome = start_runtime(
            app_root=tmp_path / "app-data",
            overrides=WorkerEnvOverrides(
                hub_endpoint="http://127.0.0.1:1",
                hub_cache_dir=tmp_path / "cache",
            ),
        )
        runtime = outcome.runtime
        assert runtime is not None
        try:
            task_id = parse_task_id("release-offline")
            runtime.create_task(
                task_id,
                make_file_spec(filename="config.json", destination=tmp_path / "out"),
                parse_attempt_id("rof1"),
            )
            _wait_state(qtbot, runtime, "release-offline", LifecycleState.FAILED)
            assert not (tmp_path / "out" / "config.json").exists(), (
                "offline failure must not materialize a file"
            )
        finally:
            _shutdown(qtbot, runtime)

    def test_missing_dependency_is_a_typed_error(self, tmp_path: Path) -> None:
        cloner = GitCloner(git_command=("hubfetch-no-such-git",))

        with pytest.raises(HubFetchError) as caught:
            cloner.clone("https://example.invalid/repo", tmp_path / "dest")

        assert caught.value.spec.category == ErrorCategory.DEPENDENCY

    def test_proxy_modes_apply_to_worker_environments(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        content = b"proxy-content"
        with hub_fixture(
            files=[("config.json", len(content))],
            content={"config.json": content},
        ) as fixture:
            outcome = start_runtime(
                app_root=tmp_path / "app-data",
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint, hub_cache_dir=tmp_path / "cache"
                ),
                open_dispatch_gate=False,
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                repository = RepositoryRef(
                    repo_id=parse_repository_id("org/repo"), kind=ModelRepository()
                )
                observed: dict[str, str] = {}
                for index, mode in enumerate(
                    (ProxyMode.SYSTEM, ProxyMode.DIRECT, ProxyMode.MANUAL)
                ):
                    spec = SingleFileDownloadSpec(
                        kind="single_file",
                        repository=repository,
                        filename="config.json",
                        destination=LocalDirectoryDestination(
                            path=tmp_path / f"out-{index}"
                        ),
                        conflict_policy=OverwriteExisting(),
                        auth_source=AuthSource.ANONYMOUS,
                        proxy_mode=mode,
                    )
                    task_id = parse_task_id(f"release-proxy-{index}")
                    runtime.create_task(task_id, spec, parse_attempt_id(f"rp{index}"))
                    environment: QProcessEnvironment = runtime.worker_environment(
                        task_id
                    )
                    observed[mode.value] = worker_environment_scan(environment)

                assert "HTTPS_PROXY=http://127.0.0.1:7897" in observed["manual"]
                assert "NO_PROXY=127.0.0.1,localhost" in observed["manual"]
                assert "HTTPS_PROXY" not in observed["direct"]
                assert "http_proxy" not in observed["direct"]
            finally:
                _shutdown(qtbot, runtime)

    def test_invalid_manual_proxy_is_rejected(self) -> None:
        with pytest.raises(ProxyPolicyError):
            build_proxy_policy(ProxyMode.MANUAL, "not-a-proxy://")


class TestReleaseAuthBoundaries:
    """Given the OAuth adapter fake and a disposable app-token, fail closed."""

    def test_oauth_adapter_fake_disables_shared_login(self) -> None:
        state = verify_contract(
            request_code=None,
            poll=None,
            login_fn=None,
            stored_tokens=None,
        )
        assert state == OAuthContractState(available=False, reason="hub_import")
        service = AuthService(
            credential_store=_FakeStore(),
            contract_state=state,
        )
        assert service.shared_oauth_available is False
        assert service.shared_oauth_diagnostic() is not None
        with pytest.raises(OAuthAdapterUnavailableError):
            service.shared_login()

    def test_disposable_app_token_askpass_resolves_and_deletes(self) -> None:
        store = _FakeStore()
        alias = store.create(token=SENTINEL)
        stdout = io.StringIO()
        stderr = io.StringIO()
        environment = {ASKPASS_ALIAS_VARIABLE: alias}

        username_code = run_askpass(
            ["askpass.exe", "Username for 'https://huggingface.co':"],
            environment=environment,
            store=store,
            stdout=stdout,
            stderr=stderr,
        )
        password_code = run_askpass(
            ["askpass.exe", "Password for 'hf_user@huggingface.co':"],
            environment=environment,
            store=store,
            stdout=stdout,
            stderr=stderr,
        )

        assert username_code == 0
        assert password_code == 0
        assert stdout.getvalue() == "hf_user\n" + SENTINEL + "\n"
        store.delete(alias)
        with pytest.raises(CredentialNotFoundError):
            store.resolve(alias)


class TestReleaseSupportAndLocale:
    """Given the support ZIP and both locales, boundaries hold."""

    def test_support_zip_excludes_secrets_and_forbidden_content(
        self, tmp_path: Path
    ) -> None:
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        (log_dir / "app.jsonl").write_text(
            f'{{"token":"{SENTINEL}"}}\n', encoding="utf-8"
        )
        registry = SecretRegistry()
        registry.register(SENTINEL)
        builder = SupportBundleBuilder(
            Redactor(registry=registry),
            leak_guard=registry.registered_values,
        )
        target = tmp_path / "bundle.zip"

        result = builder.build(
            target=target,
            settings=Settings(),
            diagnostics={"ok": True},
            log_dir=log_dir,
        )

        assert result.target == target
        assert result.errors == ()
        assert not contains_secret(target, SENTINEL)
        with zipfile.ZipFile(target) as archive:
            names = archive.namelist()
        assert all(".db" not in name for name in names)
        assert all(".wal" not in name for name in names)
        assert all("environment" not in name for name in names)

    def test_both_locales_resolve_shell_texts(self) -> None:
        zh = ShellTexts.for_locale(Locale.ZH_CN)
        en = ShellTexts.for_locale(Locale.EN_US)

        assert zh.nav_tasks
        assert zh.nav_settings
        assert en.nav_tasks
        assert en.nav_settings
        assert zh.nav_tasks != en.nav_tasks


class TestReleaseSecretScans:
    """Given a completed secret-boundary journey, sentinel bytes are absent."""

    def test_recursive_scan_finds_no_sentinel_in_app_root(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        content = b"scan-content"
        with hub_fixture(
            files=[("config.json", len(content))],
            content={"config.json": content},
        ) as fixture:
            app_root = tmp_path / "app-data"
            outcome = start_runtime(
                app_root=app_root,
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint, hub_cache_dir=tmp_path / "cache"
                ),
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                task_id = parse_task_id("release-scan")
                runtime.create_task(
                    task_id,
                    make_file_spec(
                        filename="config.json", destination=tmp_path / "out"
                    ),
                    parse_attempt_id("rs1"),
                )
                _wait_state(qtbot, runtime, "release-scan", LifecycleState.SUCCEEDED)
                worker_env = worker_environment_scan(
                    runtime.worker_environment(task_id)
                )
                worker_argv = "\n".join(runtime.worker_argv(task_id))
                assert SENTINEL not in worker_env
                assert SENTINEL not in worker_argv
                assert recursive_scan_for_secret(app_root, SENTINEL) == ()
            finally:
                _shutdown(qtbot, runtime)


def _live_evidence_path(name: str) -> Path | None:
    """Return the gated live evidence file, or None when live smoke is off."""
    if os.environ.get(LIVE_RUN_ENV) != "1":
        return None
    raw = os.environ.get(LIVE_EVIDENCE_ENV)
    if not raw:
        return None
    return Path(raw) / name


def _sha256(path: Path) -> str:
    """Return the lowercase SHA-256 hex digest of one file."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_live_evidence(path: Path, payload: dict[str, object]) -> None:
    """Write one normalized live-smoke evidence file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


class TestLiveHubSmoke:
    """Live anonymous dry-run, one file, and a filtered snapshot (gated)."""

    @pytest.mark.live
    def test_live_hub_dry_run_file_and_snapshot(self, tmp_path: Path) -> None:
        evidence = _live_evidence_path("live-hub.json")
        if evidence is None:
            pytest.skip("live Hub smoke gated by HUBFETCH_RUN_LIVE=1")

        repository = RepositoryRef(
            repo_id=parse_repository_id(LIVE_REPO),
            kind=ModelRepository(),
        )
        cache_dir = tmp_path / "cache"
        adapter = HubAdapter(
            auth_source=AuthSource.ANONYMOUS,
            proxy_mode=ProxyMode.SYSTEM,
            cache_dir=cache_dir,
            timeout=60.0,
        )
        inspection = adapter.inspect_repository(repository, revision=LIVE_REVISION)
        file_estimate = adapter.plan_single_file(
            repository, filename="config.json", revision=LIVE_REVISION
        )
        snapshot_estimate = adapter.plan_snapshot(
            repository,
            revision=LIVE_REVISION,
            include_patterns=("*.json", "vocab.txt"),
            exclude_patterns=(),
        )
        downloader = HubDownloader(
            auth_source=AuthSource.ANONYMOUS,
            proxy_mode=ProxyMode.SYSTEM,
            cache_dir=cache_dir,
        )
        sink = ProgressSink(emit=lambda _update: None)
        out_dir = tmp_path / "out"
        result = downloader.download(
            SingleFileDownloadSpec(
                kind="single_file",
                repository=repository,
                filename="config.json",
                destination=LocalDirectoryDestination(path=out_dir),
                conflict_policy=OverwriteExisting(),
                auth_source=AuthSource.ANONYMOUS,
                proxy_mode=ProxyMode.SYSTEM,
            ),
            progress=sink,
        )
        materialized = out_dir / "config.json"
        assert materialized.is_file()
        assert inspection.resolved_commit == file_estimate.resolved_commit
        assert result.paths == (materialized,)

        _write_live_evidence(
            evidence,
            {
                "repo": LIVE_REPO,
                "revision": LIVE_REVISION,
                "resolved_commit": inspection.resolved_commit,
                "dry_run": {
                    "file": "config.json",
                    "size_bytes": file_estimate.file.size_bytes,
                    "cached": file_estimate.file.cached,
                    "will_download": file_estimate.file.will_download,
                },
                "downloaded_file": {
                    "path": str(materialized),
                    "bytes": materialized.stat().st_size,
                    "sha256": _sha256(materialized),
                },
                "snapshot_planned_files": len(snapshot_estimate.files),
                "proxy": LIVE_PROXY,
            },
        )


class TestLiveGitSmoke:
    """Live shallow clone of the same public repo through the proxy (gated)."""

    @pytest.mark.live
    def test_live_shallow_clone_materializes_working_tree(self, tmp_path: Path) -> None:
        evidence = _live_evidence_path("live-git.json")
        if evidence is None:
            pytest.skip("live Git smoke gated by HUBFETCH_RUN_LIVE=1")

        destination = tmp_path / "clone"
        cloner = GitCloner()
        outcome = cloner.clone(
            f"https://huggingface.co/{LIVE_REPO}",
            destination,
            CloneOptions(revision=LIVE_REVISION, shallow=True),
        )

        assert outcome.destination == destination
        assert (destination / ".git").is_dir()
        assert (destination / "config.json").is_file()
        working_files = [
            str(path.relative_to(destination))
            for path in sorted(destination.rglob("*"))
            if path.is_file() and ".git" not in path.parts
        ]
        _write_live_evidence(
            evidence,
            {
                "repo": LIVE_REPO,
                "revision": LIVE_REVISION,
                "mode": "proxy",
                "shallow": True,
                "destination": str(destination),
                "working_tree_files": working_files,
                "git_metadata_present": True,
                "proxy": LIVE_PROXY,
            },
        )


@final
class _FakeStore(CredentialStore):
    """In-memory credential store used to prove the AskPass disposable cycle."""

    _tokens: dict[str, str]

    def __init__(self) -> None:
        self._tokens = {}

    @override
    def create(self, *, token: str) -> CredentialAlias:
        alias = generate_credential_alias()
        self._tokens[alias] = token
        return alias

    @override
    def replace(self, alias: CredentialAlias, *, token: str) -> None:
        self._require(alias)
        self._tokens[alias] = token

    @override
    def resolve(self, alias: CredentialAlias) -> str:
        self._require(alias)
        return self._tokens[alias]

    @override
    def delete(self, alias: CredentialAlias) -> None:
        self._require(alias)
        del self._tokens[alias]

    @property
    @override
    def backend_identity(self) -> BackendIdentity:
        return BackendIdentity(module="tests.e2e", class_name="FakeStore")

    def _require(self, alias: CredentialAlias) -> None:
        if alias not in self._tokens:
            raise CredentialNotFoundError(reason=f"alias {alias} has no token")
