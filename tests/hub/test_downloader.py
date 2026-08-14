# noqa: SIZE_OK - one module must enumerate the full downloader contract:
# single-file/snapshot, cache/local destinations, filters, conflict policies,
# interrupted byte-range resume, cooperative cancellation, sanitized failures.
# pyright: reportUnknownVariableType = false
# pyright: reportUnknownMemberType = false
# pyright: reportUnknownArgumentType = false
# pyright: reportArgumentType = false
"""Wire-level download tests against the Hub-compatible HTTP fixture.

Given/When/Then throughout. Every test drives the real pinned
``huggingface_hub`` 1.27.0 download APIs through :class:`HubDownloader` against
a local HTTP fixture that serves repo metadata AND file bytes, proving
single-file/snapshot success, cache and local-directory destinations, filters,
conflict policies, library-native byte-range resume after an interrupted body,
cooperative cancellation preserving cache state, and sanitized typed failures.

The ``pyright`` directives mirror ``hubfetch.hub.adapter``: the 1.27.0 stubs
type the download ``tqdm_class`` with an incompatible tqdm type, so this module
and ``hubfetch.hub.downloader`` relax the argument diagnostics for exactly
those two callables.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

import pytest

from hubfetch.domain.errors import ErrorCategory, HubFetchError
from hubfetch.domain.task_spec import (
    AuthSource,
    CacheDestination,
    FailOnExisting,
    LocalDirectoryDestination,
    OverwriteExisting,
    PreserveExisting,
    ProxyMode,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)
from hubfetch.hub.downloader import HubDownloader
from hubfetch.hub.progress import ProgressSink, ProgressUpdate

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from hubfetch.domain.repository import RepositoryRef

    from .fixtures import HubFixtureServer

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from .fixtures import DEFAULT_COMMIT, hub_fixture
from .helpers import FILES, make_repository, pointer

BIG_FILE_BYTES: int = 11 * 1024 * 1024
"""Larger than the library's 10 MiB download chunk, forcing several updates."""


def _content_for(files: tuple[tuple[str, int], ...]) -> dict[str, bytes]:
    """Return deterministic per-file content matching the declared sizes exactly."""
    content: dict[str, bytes] = {}
    for name, size in files:
        prefix = f"content-{name}".encode()
        repetitions, remainder = divmod(size, len(prefix))
        content[name] = prefix * repetitions + b"0" * remainder
    return content


def _file_spec(
    repository: RepositoryRef,
    filename: str,
    *,
    destination: CacheDestination | LocalDirectoryDestination | None = None,
    conflict: (OverwriteExisting | PreserveExisting | FailOnExisting | None) = None,
) -> SingleFileDownloadSpec:
    """Build a single-file download spec with explicit destination/policy."""
    return SingleFileDownloadSpec(
        repository=repository,
        filename=filename,
        destination=destination or CacheDestination(),
        conflict_policy=conflict or PreserveExisting(),
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def _snapshot_spec(
    repository: RepositoryRef,
    *,
    include: tuple[str, ...] = (),
    exclude: tuple[str, ...] = (),
    destination: CacheDestination | LocalDirectoryDestination | None = None,
    conflict: (OverwriteExisting | PreserveExisting | FailOnExisting | None) = None,
) -> SnapshotDownloadSpec:
    """Build a snapshot spec with explicit filters/destination/policy."""
    return SnapshotDownloadSpec(
        repository=repository,
        include_patterns=include,
        exclude_patterns=exclude,
        destination=destination or CacheDestination(),
        conflict_policy=conflict or PreserveExisting(),
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def _downloader(fixture: HubFixtureServer, cache_dir: Path) -> HubDownloader:
    """Build a downloader pinned to one fixture endpoint and cache root."""
    return HubDownloader(
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
        endpoint=fixture.endpoint,
        cache_dir=cache_dir,
    )


def _collector() -> list[ProgressUpdate]:
    """Return a fresh progress-sample collector for assertions and evidence."""
    return []


def _sink(
    collector: list[ProgressUpdate],
    *,
    cancel: Callable[[], bool] | None = None,
) -> ProgressSink:
    """Build a sink that emits every update (interval zero) for determinism."""
    return ProgressSink(
        emit=collector.append,
        interval_seconds=0.0,
        cancel=cancel,
    )


def _get_requests(fixture: HubFixtureServer) -> list[dict[str, str | None]]:
    """Return every resolve request logged by the fixture."""
    return list(fixture.request_log)


class TestSingleFileDownload:
    """Given one file, the downloader materializes it into the chosen destination."""

    def test_download_to_cache_destination(self, tmp_path: Path) -> None:
        content = b"hubfetch-config-content"
        with hub_fixture(
            files=[("config.json", len(content))], content={"config.json": content}
        ) as fixture:
            cache_dir = tmp_path / "cache"
            downloader = _downloader(fixture, cache_dir)
            result = downloader.download(
                _file_spec(make_repository(), "config.json"),
                progress=_sink(_collector()),
            )
        assert result.destination == cache_dir
        assert len(result.paths) == 1
        assert result.paths[0].is_file()
        pointer_path = pointer(cache_dir, DEFAULT_COMMIT, "config.json")
        assert pointer_path.is_file()
        assert pointer_path.read_bytes() == content

    def test_download_to_local_directory(self, tmp_path: Path) -> None:
        content = b"local-dir-materialized"
        with hub_fixture(
            files=[("config.json", len(content))], content={"config.json": content}
        ) as fixture:
            local_dir = tmp_path / "local"
            downloader = _downloader(fixture, tmp_path / "cache")
            spec = _file_spec(
                make_repository(),
                "config.json",
                destination=LocalDirectoryDestination(path=local_dir),
            )
            result = downloader.download(spec, progress=_sink(_collector()))
        assert result.destination == local_dir
        assert (local_dir / "config.json").is_file()
        assert (local_dir / "config.json").read_bytes() == content

    def test_preserve_existing_skips_second_download(self, tmp_path: Path) -> None:
        content = b"preserved-content"
        with hub_fixture(
            files=[("config.json", len(content))], content={"config.json": content}
        ) as fixture:
            downloader = _downloader(fixture, tmp_path / "cache")
            spec = _file_spec(make_repository(), "config.json")
            _ = downloader.download(spec, progress=_sink(_collector()))
            first_get_count = len(
                [r for r in _get_requests(fixture) if r["method"] == "GET"]
            )
            result = downloader.download(spec, progress=_sink(_collector()))
            second_get_count = len(
                [r for r in _get_requests(fixture) if r["method"] == "GET"]
            )
        assert first_get_count == 1
        assert second_get_count == first_get_count
        assert result.paths[0].is_file()

    def test_overwrite_existing_redownloads(self, tmp_path: Path) -> None:
        content = b"overwrite-content"
        with hub_fixture(
            files=[("config.json", len(content))], content={"config.json": content}
        ) as fixture:
            downloader = _downloader(fixture, tmp_path / "cache")
            spec = _file_spec(
                make_repository(), "config.json", conflict=OverwriteExisting()
            )
            _ = downloader.download(spec, progress=_sink(_collector()))
            _ = downloader.download(spec, progress=_sink(_collector()))
            get_count = len([r for r in _get_requests(fixture) if r["method"] == "GET"])
        assert get_count == 2

    def test_fail_on_existing_conflicts_without_network(self, tmp_path: Path) -> None:
        content = b"conflict-content"
        with hub_fixture(
            files=[("config.json", len(content))], content={"config.json": content}
        ) as fixture:
            downloader = _downloader(fixture, tmp_path / "cache")
            _ = downloader.download(
                _file_spec(make_repository(), "config.json"),
                progress=_sink(_collector()),
            )
            spec = _file_spec(
                make_repository(), "config.json", conflict=FailOnExisting()
            )
            with pytest.raises(HubFetchError) as caught:
                downloader.download(spec, progress=_sink(_collector()))
            get_count = len([r for r in _get_requests(fixture) if r["method"] == "GET"])
        assert caught.value.spec.category == ErrorCategory.DISK
        assert get_count == 1


class TestSnapshotDownload:
    """Given a repository snapshot, filters and destinations are honored."""

    def test_snapshot_include_filters_materialize_only_selected(
        self, tmp_path: Path
    ) -> None:
        with hub_fixture(files=FILES, content=_content_for(FILES)) as fixture:
            cache_dir = tmp_path / "cache"
            downloader = _downloader(fixture, cache_dir)
            spec = _snapshot_spec(
                make_repository(), include=("config.json", "README.md")
            )
            result = downloader.download(spec, progress=_sink(_collector()))
        assert result.paths[0].is_dir()
        assert pointer(cache_dir, DEFAULT_COMMIT, "config.json").is_file()
        assert pointer(cache_dir, DEFAULT_COMMIT, "README.md").is_file()
        assert not pointer(cache_dir, DEFAULT_COMMIT, "pytorch_model.bin").exists()

    def test_snapshot_exclude_pattern_skips_excluded_files(
        self, tmp_path: Path
    ) -> None:
        with hub_fixture(files=FILES, content=_content_for(FILES)) as fixture:
            local_dir = tmp_path / "local"
            downloader = _downloader(fixture, tmp_path / "cache")
            spec = _snapshot_spec(
                make_repository(),
                exclude=("*.bin",),
                destination=LocalDirectoryDestination(path=local_dir),
            )
            result = downloader.download(spec, progress=_sink(_collector()))
        assert result.destination == local_dir
        assert (local_dir / "config.json").is_file()
        assert (local_dir / "README.md").is_file()
        assert not (local_dir / "pytorch_model.bin").exists()

    def test_snapshot_retry_with_same_cache_reuses_completed_files(
        self, tmp_path: Path
    ) -> None:
        with hub_fixture(files=FILES, content=_content_for(FILES)) as fixture:
            downloader = _downloader(fixture, tmp_path / "cache")
            spec = _snapshot_spec(make_repository())
            _ = downloader.download(spec, progress=_sink(_collector()))
            first_get_count = len(
                [r for r in _get_requests(fixture) if r["method"] == "GET"]
            )
            result = downloader.download(spec, progress=_sink(_collector()))
            second_get_count = len(
                [r for r in _get_requests(fixture) if r["method"] == "GET"]
            )
        assert first_get_count >= 1
        assert second_get_count == first_get_count
        assert result.paths[0].is_dir()


class TestInterruptedResume:
    """Given an interrupted body, the library's byte-range resume completes it."""

    def test_interrupted_download_resumes_with_byte_range(self, tmp_path: Path) -> None:
        content = b"x" * BIG_FILE_BYTES
        with hub_fixture(
            files=[("big.bin", len(content))],
            content={"big.bin": content},
            download_error={"big.bin": "truncate_once"},
        ) as fixture:
            downloader = _downloader(fixture, tmp_path / "cache")
            result = downloader.download(
                _file_spec(make_repository(), "big.bin"), progress=_sink(_collector())
            )
            ranges = [
                r["range"]
                for r in _get_requests(fixture)
                if r["filename"] == "big.bin" and r["method"] == "GET"
            ]
        assert result.paths[0].is_file()
        assert result.paths[0].read_bytes() == content
        assert any(rng is not None and rng.startswith("bytes=") for rng in ranges)

    def test_interrupted_retry_with_same_cache_reuses_completed_files(
        self, tmp_path: Path
    ) -> None:
        files = (("a.txt", 4096), ("b.bin", BIG_FILE_BYTES))
        content = _content_for(files)
        content["b.bin"] = b"y" * BIG_FILE_BYTES
        with hub_fixture(
            files=files,
            content=content,
            download_error={"b.bin": "truncate_once"},
        ) as fixture:
            downloader = _downloader(fixture, tmp_path / "cache")
            spec = _snapshot_spec(make_repository())
            result = downloader.download(spec, progress=_sink(_collector()))
            first_get_count = len(
                [r for r in _get_requests(fixture) if r["method"] == "GET"]
            )
            retry = downloader.download(spec, progress=_sink(_collector()))
            second_get_count = len(
                [r for r in _get_requests(fixture) if r["method"] == "GET"]
            )
        assert result.paths[0].is_dir()
        assert retry.paths[0].is_dir()
        assert first_get_count >= 2
        assert second_get_count == first_get_count


class TestConflictAndCancellation:
    """Given a failing or cancelled transfer, state is preserved and typed."""

    def test_checksum_mismatch_maps_to_network_error(self, tmp_path: Path) -> None:
        content = b"checksum-failing-content"
        with hub_fixture(
            files=[("config.json", len(content))],
            content={"config.json": content},
            download_error={"config.json": "checksum"},
        ) as fixture:
            downloader = _downloader(fixture, tmp_path / "cache")
            with pytest.raises(HubFetchError) as caught:
                downloader.download(
                    _file_spec(make_repository(), "config.json"),
                    progress=_sink(_collector()),
                )
        assert caught.value.spec.category == ErrorCategory.NETWORK

    def test_cancel_mid_download_raises_and_retry_completes(
        self, tmp_path: Path
    ) -> None:
        content = b"z" * BIG_FILE_BYTES
        with hub_fixture(
            files=[("big.bin", len(content))], content={"big.bin": content}
        ) as fixture:
            cache_dir = tmp_path / "cache"
            downloader = _downloader(fixture, cache_dir)
            calls = {"n": 0}

            def cancel() -> bool:
                # Two checkpoints run before the transfer; the third checkpoint
                # is the first received download chunk, and the fourth is that
                # chunk's transfer channel — so the probe flips mid-download.
                calls["n"] += 1
                return calls["n"] >= 4

            with pytest.raises(HubFetchError) as caught:
                downloader.download(
                    _file_spec(make_repository(), "big.bin"),
                    progress=_sink(_collector(), cancel=cancel),
                )
            assert cache_dir.exists()
            assert caught.value.spec.category == ErrorCategory.CANCELLATION
            result = downloader.download(
                _file_spec(make_repository(), "big.bin"),
                progress=_sink(_collector()),
            )
        assert result.paths[0].is_file()
        assert result.paths[0].read_bytes() == content

    def test_cancel_before_transfer_raises_without_writing(
        self, tmp_path: Path
    ) -> None:
        with hub_fixture(files=FILES, content=_content_for(FILES)) as fixture:
            cache_dir = tmp_path / "cache"
            downloader = _downloader(fixture, cache_dir)
            spec = _snapshot_spec(make_repository())
            with pytest.raises(HubFetchError) as caught:
                downloader.download(
                    spec, progress=_sink(_collector(), cancel=lambda: True)
                )
        assert caught.value.spec.category == ErrorCategory.CANCELLATION
        assert not list(cache_dir.rglob("blobs/*"))
