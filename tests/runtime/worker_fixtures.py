"""Cross-platform fixtures for the worker boot and handshake tests."""

from __future__ import annotations

import io
import os
from typing import TYPE_CHECKING, Final, override

from hubfetch.domain.ids import parse_attempt_id, parse_repository_id, parse_task_id
from hubfetch.domain.ipc import StartTaskCommand
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import (
    AuthSource,
    LocalDirectoryDestination,
    OverwriteExisting,
    ProxyMode,
    SingleFileDownloadSpec,
)
from hubfetch.network.proxy import ProxyPolicy, build_proxy_policy
from hubfetch.runtime.process_environment import hub_worker_environment

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

    from PySide6.QtCore import QProcessEnvironment

HF_TEST_SECRET: Final = "hf_test_secret_123"  # noqa: S105
TASK_ID = parse_task_id("task-1")
ATTEMPT_ID = parse_attempt_id("attempt-1")
READY_TIMEOUT_MS: Final = 10_000


def poisoned_parent() -> dict[str, str]:
    """Return the live parent environment poisoned with token and auth vars."""
    parent = dict(os.environ)
    parent.update(
        {
            "HF_TOKEN": HF_TEST_SECRET,
            "HUGGING_FACE_HUB_TOKEN": "legacy-token",
            "GIT_ASKPASS": "C:\\askpass.exe",
            "SSH_ASKPASS": "C:\\askpass.exe",
            "SSH_ASKPASS_REQUIRE": "force",
            "HUBFETCH_SENTINEL": "must-not-leak",
            "HTTP_PROXY": "http://inherited:8080",
            "HTTPS_PROXY": "http://inherited:8080",
        }
    )
    return parent


def system_policy() -> ProxyPolicy:
    """Return the inherited system proxy policy."""
    return build_proxy_policy(ProxyMode.SYSTEM)


def worker_environment() -> QProcessEnvironment:
    """Build the sanitized worker environment from a poisoned parent."""
    return hub_worker_environment(poisoned_parent(), system_policy())


def download_spec(destination_path: Path) -> SingleFileDownloadSpec:
    """Build one single-file download spec targeting a local directory."""
    return SingleFileDownloadSpec(
        repository=RepositoryRef(
            repo_id=parse_repository_id("author/name"), kind=ModelRepository()
        ),
        filename="config.json",
        destination=LocalDirectoryDestination(path=destination_path),
        conflict_policy=OverwriteExisting(),
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def start_task_command(destination_path: Path) -> StartTaskCommand:
    """Build one start_task envelope targeting the given destination."""
    return StartTaskCommand(
        task_id=TASK_ID, attempt_id=ATTEMPT_ID, spec=download_spec(destination_path)
    )


class PipedStdio:
    """Fake stdio exposing a binary ``buffer`` for ``main`` monkeypatching."""

    buffer: io.BytesIO

    def __init__(self, binary: io.BytesIO) -> None:
        self.buffer = binary


class ChunkedStream(io.BytesIO):
    """A binary stream that serves one pre-sliced chunk per readline call."""

    _chunks: list[bytes]

    def __init__(self, chunks: Sequence[bytes]) -> None:
        super().__init__()
        self._chunks = list(chunks)

    @override
    def readline(self, size: int | None = -1) -> bytes:
        if not self._chunks:
            return b""
        return self._chunks.pop(0)
