"""Wire-level planning tests against a deterministic Hub-compatible fixture.

Given/When/Then throughout. Every test drives the real pinned adapter and the
real ``huggingface_hub`` library against a local HTTP fixture that mimics the
Hub API exactly, proving file and snapshot planning, revision handling, cache
estimates, and disk readiness without any external network. Auth-mode and
Hub-error mapping tests live in ``tests/hub/test_planner_errors.py``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from hubfetch.domain.errors import ErrorCategory, HubFetchError, RecoveryAction
from hubfetch.domain.repository import DatasetRepository, SpaceRepository
from hubfetch.hub.contracts import PlannedFile, SingleFileEstimate, SnapshotEstimate
from hubfetch.hub.planner import DownloadPlanner

if TYPE_CHECKING:
    from pathlib import Path

from .fixtures import DEFAULT_COMMIT, hub_fixture
from .helpers import (
    FILES,
    DiskUsage,
    FakeHubAdapter,
    make_adapter,
    make_file_spec,
    make_repository,
    make_snapshot_spec,
    pointer,
)


class TestSingleFilePlanning:
    """Given a fixture with files, when planning one file, the estimate is exact."""

    def test_plan_single_file_model_anonymous_returns_estimate(
        self, tmp_path: Path
    ) -> None:
        with hub_fixture(files=FILES) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert plan.kind == "file"
        assert plan.resolved_commit == DEFAULT_COMMIT
        assert plan.total_bytes == 554
        assert plan.cache_hits == 0
        assert plan.cache_misses == 1
        assert len(plan.selected_files) == 1
        assert plan.selected_files[0].path == "config.json"
        assert plan.selected_files[0].will_download is True
        assert plan.space.sufficient is True

    def test_plan_single_file_dataset_repository(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES, repo_type="dataset") as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(
                make_file_spec(make_repository(kind=DatasetRepository), "README.md")
            )
        assert plan.resolved_commit == DEFAULT_COMMIT
        assert plan.total_bytes == 391

    def test_plan_single_file_space_repository(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES, repo_type="space") as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(
                make_file_spec(make_repository(kind=SpaceRepository), "config.json")
            )
        assert plan.resolved_commit == DEFAULT_COMMIT
        assert plan.total_bytes == 554


class TestRevisionHandling:
    """Given revisions, when planning, then branch, tag, commit revisions resolve."""

    def test_plan_with_tag_revision(self, tmp_path: Path) -> None:
        repository = make_repository(revision="v1.0")
        with hub_fixture(files=FILES, revisions=("main", "v1.0")) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(make_file_spec(repository, "config.json"))
        assert plan.resolved_commit == DEFAULT_COMMIT

    def test_plan_with_full_commit_revision(self, tmp_path: Path) -> None:
        commit = "b" * 40
        repository = make_repository(revision=commit)
        with hub_fixture(
            files=FILES, revisions=("main", commit), commit=commit
        ) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(make_file_spec(repository, "config.json"))
        assert plan.resolved_commit == commit

    def test_plan_without_revision_uses_default_main(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES, revisions=("main",)) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert plan.resolved_commit == DEFAULT_COMMIT

    def test_unknown_revision_maps_to_not_found(self, tmp_path: Path) -> None:
        repository = make_repository(revision="does-not-exist")
        with hub_fixture(files=FILES, revisions=("main",)) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(repository, "config.json"))
        assert caught.value.spec.category is ErrorCategory.NOT_FOUND
        assert caught.value.recovery_action is RecoveryAction.CHECK_REVISION

    def test_malformed_commit_length_revision_is_rejected(self, tmp_path: Path) -> None:
        repository = make_repository(revision="z" * 40)
        with hub_fixture(files=FILES) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(repository, "config.json"))
        assert caught.value.spec.category is ErrorCategory.VALIDATION


class TestSnapshotPlanning:
    """Given include/exclude filters, when planning, then library filters apply."""

    def test_plan_snapshot_filters_by_include(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(
                make_snapshot_spec(make_repository(), include=("*.json", "*.md"))
            )
        assert plan.kind == "snapshot"
        assert plan.resolved_commit == DEFAULT_COMMIT
        assert len(plan.selected_files) == 2
        assert plan.total_bytes == 554 + 391
        assert plan.cache_hits == 0
        assert plan.cache_misses == 2

    def test_plan_snapshot_excludes_pattern(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(
                make_snapshot_spec(make_repository(), exclude=("*.bin",))
            )
        assert len(plan.selected_files) == 3
        assert plan.total_bytes == 554 + 391 + 700

    def test_plan_snapshot_nested_include(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(
                make_snapshot_spec(make_repository(), include=("onnx/*",))
            )
        assert [file.path for file in plan.selected_files] == ["onnx/model.onnx"]
        assert plan.total_bytes == 700


class TestCacheEstimates:
    """Given a pre-populated cache, when planning, hit/miss estimates are exact."""

    def test_plan_single_file_cache_hit(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        target = pointer(cache_dir, DEFAULT_COMMIT, "config.json")
        target.parent.mkdir(parents=True, exist_ok=True)
        _ = target.write_text("x" * 554)
        with hub_fixture(files=FILES) as fixture:
            planner = DownloadPlanner(make_adapter(fixture, cache_dir=cache_dir))
            plan = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert plan.cache_hits == 1
        assert plan.cache_misses == 0
        assert plan.selected_files[0].cached is True
        assert plan.selected_files[0].will_download is False

    def test_plan_snapshot_mixed_cache_hits_and_misses(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        target = pointer(cache_dir, DEFAULT_COMMIT, "README.md")
        target.parent.mkdir(parents=True, exist_ok=True)
        _ = target.write_text("x" * 391)
        with hub_fixture(files=FILES) as fixture:
            planner = DownloadPlanner(make_adapter(fixture, cache_dir=cache_dir))
            plan = planner.plan(
                make_snapshot_spec(make_repository(), include=("*.json", "*.md"))
            )
        assert plan.cache_hits == 1
        assert plan.cache_misses == 1
        assert plan.total_bytes == 554 + 391


class TestDiskAssessment:
    """Given controlled free space, when planning, the assessment is truthful."""

    @staticmethod
    def _usage_limited(_path: object) -> DiskUsage:
        del _path
        return DiskUsage(total=1000, used=900, free=100)

    @staticmethod
    def _usage_roomy(_path: object) -> DiskUsage:
        del _path
        return DiskUsage(total=100_000, used=10_000, free=90_000)

    def test_plan_disk_insufficient_is_flagged(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "hubfetch.diagnostics.disk._disk_usage", self._usage_limited
        )
        with hub_fixture(files=FILES) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert plan.space.sufficient is False
        assert plan.space.shortfall_bytes == 554 - 100

    def test_plan_disk_sufficient_is_confirmed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("hubfetch.diagnostics.disk._disk_usage", self._usage_roomy)
        with hub_fixture(files=FILES) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert plan.space.sufficient is True

    def test_plan_unknown_size_keeps_disk_unknown(self, tmp_path: Path) -> None:
        adapter = FakeHubAdapter(
            cache_dir=tmp_path / "cache",
            file_estimate=SingleFileEstimate(
                resolved_commit=DEFAULT_COMMIT,
                file=PlannedFile(
                    path="config.json",
                    size_bytes=None,
                    cached=False,
                    will_download=True,
                ),
            ),
            snapshot_estimate=SnapshotEstimate(
                resolved_commit=DEFAULT_COMMIT,
                files=(
                    PlannedFile(
                        path="config.json",
                        size_bytes=None,
                        cached=False,
                        will_download=True,
                    ),
                ),
            ),
        )
        planner = DownloadPlanner(adapter)
        plan = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert plan.total_bytes is None
        assert plan.space.sufficient is None
