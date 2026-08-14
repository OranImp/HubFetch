"""End-to-end secret-boundary tests: the sentinel never leaves the vault.

A manual-token task resolves its opaque alias inside the worker from the real
Windows Credential Manager, the fixture proves the token was sent by refusing
every other request, and recursive scans prove the sentinel bytes never appear
in the SQLite database, captured worker argv, worker environment, or evidence.
"""

from __future__ import annotations

import platform
from typing import TYPE_CHECKING, Final

import pytest
from keyring.backends.Windows import WinVaultKeyring

from hubfetch.application.bootstrap import WorkerEnvOverrides
from hubfetch.credentials.windows_keyring import WindowsCredentialManagerStore
from hubfetch.domain.ids import parse_attempt_id, parse_task_id
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.domain.task_spec import AuthSource
from tests.e2e.support import (
    make_file_spec,
    recursive_scan_for_secret,
    start_runtime,
    worker_environment_scan,
)
from tests.hub.fixtures import hub_fixture

if TYPE_CHECKING:
    from pathlib import Path

    from pytestqt.qtbot import QtBot

    from hubfetch.application.runtime import Runtime

pytestmark = pytest.mark.windows
if platform.system() != "Windows":
    pytest.skip(allow_module_level=True)

WAIT_TIMEOUT_MS: Final = 60_000
SECRET: Final = "hf_test_secret_123"  # noqa: S105


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
    """Bounded orderly shutdown of one runtime."""
    shutdown = runtime.shutdown()
    qtbot.waitUntil(lambda: shutdown.finished_cleanly, timeout=WAIT_TIMEOUT_MS)
    runtime.close()


class TestManualTokenSecretBoundary:
    """Given a vault-backed token, the sentinel stays out of every boundary."""

    def test_sentinel_absent_from_db_argv_environment_and_evidence(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        content = b"secret-boundary-content"
        with hub_fixture(
            files=[("config.json", len(content))],
            content={"config.json": content},
            expect_token=SECRET,
        ) as fixture:
            # Pin the Windows Credential Manager backend explicitly: earlier
            # credential-policy tests import keyring backend modules that flip
            # keyring's cached ambient backend inside the pytest process, and
            # the store deliberately fails closed on anything but WinVault.
            store = WindowsCredentialManagerStore(backend=WinVaultKeyring())
            alias = store.create(token=SECRET)
            try:
                app_root = tmp_path / "app-data"
                outcome = start_runtime(
                    app_root=app_root,
                    overrides=WorkerEnvOverrides(
                        hub_endpoint=fixture.endpoint,
                        hub_cache_dir=tmp_path / "cache",
                        credential_alias=alias,
                    ),
                )
                runtime = outcome.runtime
                assert runtime is not None
                try:
                    task_id = parse_task_id("secret-download")
                    runtime.create_task(
                        task_id,
                        make_file_spec(
                            filename="config.json",
                            destination=tmp_path / "out",
                            auth=AuthSource.MANUAL_TOKEN,
                        ),
                        parse_attempt_id("secret-a1"),
                    )

                    # Success is the proof the token matched the fixture: every
                    # request without the exact bearer token returns 401.
                    _wait_state(
                        qtbot, runtime, "secret-download", LifecycleState.SUCCEEDED
                    )
                    out = tmp_path / "out" / "config.json"
                    assert out.is_file()
                    assert out.read_bytes() == content

                    worker_env = worker_environment_scan(
                        runtime.worker_environment(task_id)
                    )
                    worker_argv = "\n".join(runtime.worker_argv(task_id))
                    assert SECRET not in worker_env
                    assert SECRET not in worker_argv
                    assert alias in worker_env  # the opaque alias is not secret

                    assert recursive_scan_for_secret(app_root, SECRET) == (), (
                        "sentinel leaked into the application data root"
                    )
                    assert recursive_scan_for_secret(tmp_path, SECRET) == (), (
                        "sentinel leaked into the run directory"
                    )
                finally:
                    _shutdown(qtbot, runtime)
            finally:
                store.delete(alias)


class TestAnonymousSecretBoundary:
    """Given anonymous auth, no bearer token is ever sent to the fixture."""

    def test_anonymous_download_sends_no_token(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        content = b"anonymous-boundary-content"
        with hub_fixture(
            files=[("config.json", len(content))],
            content={"config.json": content},
            forbid_token=True,
        ) as fixture:
            outcome = start_runtime(
                app_root=tmp_path / "app-data",
                overrides=WorkerEnvOverrides(
                    hub_endpoint=fixture.endpoint,
                    hub_cache_dir=tmp_path / "cache",
                ),
            )
            runtime = outcome.runtime
            assert runtime is not None
            try:
                task_id = parse_task_id("anonymous-download")
                runtime.create_task(
                    task_id,
                    make_file_spec(
                        filename="config.json", destination=tmp_path / "out"
                    ),
                    parse_attempt_id("anon-a1"),
                )

                # forbid_token means the fixture refuses every request that
                # carries an Authorization header, so success proves no token.
                _wait_state(
                    qtbot, runtime, "anonymous-download", LifecycleState.SUCCEEDED
                )
                assert (tmp_path / "out" / "config.json").is_file()
            finally:
                _shutdown(qtbot, runtime)
