"""Contract tests for deterministic cross-process test helpers."""

from __future__ import annotations

import shutil
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from http.client import HTTPConnection, HTTPResponse
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

import pytest

if TYPE_CHECKING:
    from collections.abc import Mapping

from tests.helpers.clock import ControllableClock
from tests.helpers.evidence import (
    EvidenceWriter,
    capture_process_command,
    scan_test_source_policy,
)
from tests.helpers.factories import (
    TaskEvent,
    TaskSpec,
    TaskState,
    make_task_event,
    make_task_spec,
    make_task_state,
)
from tests.helpers.git_repo import bare_git_repository
from tests.helpers.http_server import local_http_server
from tests.helpers.processes import (
    ManagedProcess,
    ProcessLeakError,
    assert_process_tree_clean,
    create_run_namespace,
    terminate_process_tree,
)


def _request(
    url: str, headers: Mapping[str, str] | None = None
) -> tuple[HTTPConnection, HTTPResponse]:
    parts = urlsplit(url)
    assert parts.hostname is not None
    assert parts.port is not None
    connection = HTTPConnection(parts.hostname, parts.port)
    connection.request("GET", parts.path, headers=dict(headers or {}))
    return connection, connection.getresponse()


def test_factories_create_additive_typed_values() -> None:
    spec = TaskSpec(name="download", parameters=(("revision", "main"),))
    state = TaskState(name="queued", terminal=False)
    event = TaskEvent(sequence=1, name="created", task=spec, state=state)

    assert spec.parameters == (("revision", "main"),)
    assert state.terminal is False
    assert event.task is spec
    assert event.state is state
    assert make_task_spec(spec.name, spec.parameters) == spec
    assert make_task_state(state.name, state.terminal) == state
    assert make_task_event(event.sequence, spec, state).task == spec


def test_controllable_clock_advances_without_wall_clock() -> None:
    start = datetime(2026, 1, 1, 12, tzinfo=UTC)
    clock = ControllableClock(start)

    assert clock.now() == start
    assert clock.advance(timedelta(seconds=7)) == start + timedelta(seconds=7)
    assert clock.now() == start + timedelta(seconds=7)


def test_run_namespace_owns_unique_roots_and_cleans_up(tmp_path: Path) -> None:
    with create_run_namespace(tmp_path) as first:
        with create_run_namespace(tmp_path) as second:
            assert first.namespace != second.namespace
            assert first.root != second.root
            assert first.app_root != first.cache_root
            assert first.app_root.is_dir()
            assert first.cache_root.is_dir()
            assert first.evidence_root.is_dir()
        second_root = second.root

    first_root = first.root
    assert not first_root.exists()
    assert not second_root.exists()


def test_local_http_server_supports_ranges_errors_auth_and_cleanup(
    tmp_path: Path,
) -> None:
    with create_run_namespace(tmp_path) as namespace:
        with local_http_server(
            namespace=namespace.namespace,
            content=b"abcdef",
        ) as server:
            range_connection, response = _request(
                server.url_for("file"), {"Range": "bytes=1-3"}
            )
            try:
                assert response.status == 206
                assert response.getheader("Content-Range") == "bytes 1-3/6"
                assert response.read() == b"bcd"
            finally:
                range_connection.close()

            error_connection, error_response = _request(server.url_for("status/503"))
            try:
                assert error_response.status == 503
            finally:
                error_connection.close()

            auth_connection, auth_response = _request(server.url_for("auth"))
            try:
                assert auth_response.status == 401
                assert auth_response.getheader("WWW-Authenticate") is not None
            finally:
                auth_connection.close()

            authenticated_connection, authenticated_response = _request(
                server.url_for("auth"),
                {"Authorization": "Basic dGVzdDp0ZXN0"},
            )
            try:
                assert authenticated_response.status == 200
            finally:
                authenticated_connection.close()

            port = server.port
            assert port > 0

        assert server.closed
        assert port > 0


def test_bare_git_repository_is_local_and_bare(tmp_path: Path) -> None:
    git_executable = shutil.which("git")
    assert git_executable is not None
    with bare_git_repository(parent=tmp_path, namespace="contract") as repository:
        result = subprocess.run(  # noqa: S603
            [git_executable, "rev-parse", "--is-bare-repository"],
            cwd=repository.path,
            check=True,
            capture_output=True,
            text=True,
        )
        assert result.stdout.strip() == "true"
        assert repository.path.is_dir()

    assert not repository.path.exists()


def test_process_helper_uses_ready_event_and_bounded_tree_cleanup(
    tmp_path: Path,
) -> None:
    child_code = "import threading; threading.Event().wait()"
    parent_code = (
        "import subprocess, sys, threading; "
        "child = subprocess.Popen([sys.executable, '-c', "
        f"{child_code!r}"
        "]); "
        "print(f'READY:{child.pid}', flush=True); "
        "threading.Event().wait()"
    )

    with create_run_namespace(tmp_path) as namespace:
        process = ManagedProcess(
            (sys.executable, "-c", parent_code),
            cwd=namespace.app_root,
        )
        process.start()
        try:
            process.wait_ready(timeout_seconds=5.0)
            assert any(line.startswith("READY:") for line in process.output)
            with pytest.raises(ProcessLeakError):
                assert_process_tree_clean(process)

            receipt = terminate_process_tree(process, timeout_seconds=5.0)
            assert receipt.tree_terminated
            assert receipt.pid == process.pid
            assert_process_tree_clean(process)
        finally:
            if process.is_running:
                _ = terminate_process_tree(process, timeout_seconds=5.0)


def test_process_command_capture_is_normalized() -> None:
    snapshot = capture_process_command(
        (sys.executable, "-c", "print('ready')"),
        {"HF_TEST": "value"},
    )

    assert snapshot.argv[0] == sys.executable
    assert snapshot.environment == (("HF_TEST", "value"),)


def test_evidence_writer_normalizes_names_and_writes_structured_files(
    tmp_path: Path,
) -> None:
    writer = EvidenceWriter(tmp_path / "run evidence", "HTTP Probe #1")

    text_path = writer.write_text("cleanup receipt", "closed")
    json_path = writer.write_json("run details", {"port": 0, "clean": True})
    png_path = writer.write_png("shell state", b"PNG")

    assert text_path.name == "cleanup_receipt.txt"
    assert json_path.name == "run_details.json"
    assert png_path.name == "shell_state.png"
    assert text_path.read_text(encoding="utf-8") == "closed"
    assert json_path.read_text(encoding="utf-8").find('"clean": true') >= 0
    assert png_path.read_bytes() == b"PNG"


def test_source_policy_rejects_sleep_and_fixed_shared_paths(tmp_path: Path) -> None:
    fixed_path = "C:" + chr(47) + "shared"
    violating_source = "".join(
        (
            "import time\n",
            "time",
            ".sleep(0.1)\n",
            "from pathlib import Path\n",
            f"Path({fixed_path!r})\n",
        )
    )
    violating_file = tmp_path / "test_violation.py"
    _ = violating_file.write_text(violating_source, encoding="utf-8")

    violations = scan_test_source_policy((violating_file,))

    assert {violation.rule for violation in violations} == {
        "no-sleep",
        "fixed-path",
    }
    assert all(violation.path == violating_file for violation in violations)


def test_repository_tests_have_no_forbidden_synchronization_or_paths() -> None:
    tests_root = Path(__file__).resolve().parents[1]
    helper_scope = (tests_root / "helpers", tests_root / "test_harness")

    violations = scan_test_source_policy(
        path for scope in helper_scope for path in scope.rglob("*.py")
    )

    assert violations == (), "\n".join(violation.render() for violation in violations)
