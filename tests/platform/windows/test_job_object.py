"""Windows-only tests for the typed Job Object containment adapter.

Every test uses bounded event-based waits and the bounded empty-job
observation; no test sleeps to synchronize steps. Layout tests assert the
documented Win32 x64 ABI so the adapter's packed structures stay honest.
"""

from __future__ import annotations

import ctypes
import platform
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

if platform.system() != "Windows":
    pytest.skip(allow_module_level=True)

from tests.fixtures.process_tree import (
    BlockedTree,
    force_cleanup,
    spawn_blocked_tree,
    wait_for_job_empty,
    wait_for_process_exit,
)

from hubfetch.platform.windows.job_object import (
    AssignProcessError,
    JobObject,
    JobObjectClosedError,
    OpenProcessError,
    open_process,
)
from hubfetch.platform.windows.job_object_types import (
    JobObjectBasicAccountingInformation,
    JobObjectBasicLimitInformation,
    JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation,
    field_offsets,
)

pytestmark = pytest.mark.windows

_JOB_TIMEOUT_SECONDS: float = 10.0


@pytest.fixture
def blocked_tree(tmp_path: Path) -> Iterator[BlockedTree]:
    """Yield a blocked fixture tree and force-clean any survivors afterwards."""
    tree = spawn_blocked_tree(tmp_path / "child.pid")
    try:
        yield tree
    finally:
        force_cleanup(tree, timeout_seconds=_JOB_TIMEOUT_SECONDS)


def test_basic_limit_information_matches_documented_x64_layout() -> None:
    """Given the documented Win32 structure, x64 sizes and offsets match."""
    assert ctypes.sizeof(JobObjectBasicLimitInformation) == 64
    offsets = field_offsets(JobObjectBasicLimitInformation)
    assert offsets["PerProcessUserTimeLimit"] == 0
    assert offsets["PerJobUserTimeLimit"] == 8
    assert offsets["LimitFlags"] == 16
    assert offsets["MinimumWorkingSetSize"] == 24
    assert offsets["MaximumWorkingSetSize"] == 32
    assert offsets["ActiveProcessLimit"] == 40
    assert offsets["Affinity"] == 48
    assert offsets["PriorityClass"] == 56
    assert offsets["SchedulingClass"] == 60


def test_extended_limit_information_matches_documented_x64_layout() -> None:
    """Given the documented Win32 structure, the x64 size is 144 bytes."""
    assert ctypes.sizeof(JobObjectExtendedLimitInformation) == 144


def test_basic_accounting_information_matches_documented_x64_layout() -> None:
    """Given the documented Win32 structure, x64 sizes and offsets match."""
    assert ctypes.sizeof(JobObjectBasicAccountingInformation) == 48
    offsets = field_offsets(JobObjectBasicAccountingInformation)
    assert offsets["ActiveProcesses"] == 40


def test_basic_process_id_list_matches_documented_x64_layout() -> None:
    """Given the pshpack4 Win32 structure, x64 sizes and offsets match."""
    assert ctypes.sizeof(JobObjectBasicProcessIdList) == 16
    offsets = field_offsets(JobObjectBasicProcessIdList)
    assert offsets["NumberOfAssignedProcesses"] == 0
    assert offsets["NumberOfProcessIdsInList"] == 4
    assert offsets["ProcessIdList"] == 8


def test_assigned_parent_is_observed_in_the_job(blocked_tree: BlockedTree) -> None:
    """Given an opened blocked process, assignment makes it a job member."""
    job = JobObject()
    try:
        with open_process(blocked_tree.parent_pid) as process:
            job.assign(process)
        assert blocked_tree.parent_pid in job.active_process_ids()
        job.terminate()
        wait_for_job_empty(job, timeout_seconds=_JOB_TIMEOUT_SECONDS)
        blocked_tree.wait_parent(_JOB_TIMEOUT_SECONDS)
    finally:
        job.close()


def test_child_spawned_after_assignment_inherits_the_job(
    blocked_tree: BlockedTree,
) -> None:
    """Given a parent assigned before spawning, its later child joins the job."""
    job = JobObject()
    try:
        with open_process(blocked_tree.parent_pid) as process:
            job.assign(process)
        child_pid = blocked_tree.spawn_child()
        assert child_pid != blocked_tree.parent_pid
        member_pids = job.active_process_ids()
        assert blocked_tree.parent_pid in member_pids
        assert child_pid in member_pids
        job.terminate()
        wait_for_job_empty(job, timeout_seconds=_JOB_TIMEOUT_SECONDS)
        blocked_tree.wait_parent(_JOB_TIMEOUT_SECONDS)
    finally:
        job.close()
    wait_for_process_exit(child_pid, timeout_seconds=_JOB_TIMEOUT_SECONDS)


def test_active_process_count_observes_assigned_members(
    blocked_tree: BlockedTree,
) -> None:
    """Given an assigned tree, the active count matches the PID list length."""
    job = JobObject()
    try:
        with open_process(blocked_tree.parent_pid) as process:
            job.assign(process)
        assert job.active_process_count() == 1
        blocked_tree.spawn_child()
        member_pids = job.active_process_ids()
        assert job.active_process_count() == len(member_pids)
        job.terminate()
        wait_for_job_empty(job, timeout_seconds=_JOB_TIMEOUT_SECONDS)
        blocked_tree.wait_parent(_JOB_TIMEOUT_SECONDS)
    finally:
        job.close()


def test_closing_job_handle_kills_the_whole_tree(blocked_tree: BlockedTree) -> None:
    """Given kill-on-close, closing the last handle terminates all members."""
    job = JobObject()
    try:
        with open_process(blocked_tree.parent_pid) as process:
            job.assign(process)
        child_pid = blocked_tree.spawn_child()
        assert child_pid in job.active_process_ids()
    finally:
        job.close()
    blocked_tree.wait_parent(_JOB_TIMEOUT_SECONDS)
    wait_for_process_exit(child_pid, timeout_seconds=_JOB_TIMEOUT_SECONDS)


def test_terminate_empties_the_job_before_reporting_success(
    blocked_tree: BlockedTree,
) -> None:
    """Given explicit termination, the bounded empty-job observation succeeds."""
    job = JobObject()
    try:
        with open_process(blocked_tree.parent_pid) as process:
            job.assign(process)
        blocked_tree.spawn_child()
        job.terminate()
        wait_for_job_empty(job, timeout_seconds=_JOB_TIMEOUT_SECONDS)
        blocked_tree.wait_parent(_JOB_TIMEOUT_SECONDS)
    finally:
        job.close()


def test_close_is_idempotent_for_job_and_process_handles(
    blocked_tree: BlockedTree,
) -> None:
    """Given repeated close calls, both handle owners stay closed without error."""
    job = JobObject()
    with open_process(blocked_tree.parent_pid) as process:
        process.close()
        process.close()
        assert not process.is_open
    job.close()
    job.close()
    assert not job.is_open


def test_assigning_a_closed_process_handle_raises_typed_error(
    blocked_tree: BlockedTree,
) -> None:
    """Given a handle closed before assignment, a typed error leaves the job empty."""
    job = JobObject()
    try:
        with open_process(blocked_tree.parent_pid) as process:
            process.close()
            with pytest.raises(AssignProcessError):
                job.assign(process)
        assert job.active_process_ids() == ()
    finally:
        job.close()


def test_assigning_to_a_closed_job_raises_typed_error(
    blocked_tree: BlockedTree,
) -> None:
    """Given a closed job, assignment raises without touching the process."""
    job = JobObject()
    job.close()
    with (
        open_process(blocked_tree.parent_pid) as process,
        pytest.raises(JobObjectClosedError),
    ):
        job.assign(process)


def test_open_process_with_invalid_pid_raises_typed_error() -> None:
    """Given a PID that cannot be opened, a typed Win32 error is raised."""
    with pytest.raises(OpenProcessError) as raised:
        open_process(0)
    assert raised.value.code != 0


def test_no_surviving_processes_or_handles_after_cleanup(
    blocked_tree: BlockedTree,
) -> None:
    """Given a full lifecycle, no PID or handle survives the cleanup."""
    job = JobObject()
    try:
        with open_process(blocked_tree.parent_pid) as process:
            job.assign(process)
            process.close()
            assert not process.is_open
        child_pid = blocked_tree.spawn_child()
        job.terminate()
        wait_for_job_empty(job, timeout_seconds=_JOB_TIMEOUT_SECONDS)
        blocked_tree.wait_parent(_JOB_TIMEOUT_SECONDS)
    finally:
        job.close()
    assert not job.is_open
    wait_for_process_exit(child_pid, timeout_seconds=_JOB_TIMEOUT_SECONDS)
