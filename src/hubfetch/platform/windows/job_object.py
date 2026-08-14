"""Typed Windows Job Object containment boundary with owned native handles.

The low-level typed Win32 surface lives in ``win32_surface`` and typed errors in
``job_object_errors``; this module owns the containment semantics. The adapter
never exposes raw handle integers through its public API — callers receive
``ProcessHandle`` and ``JobObject`` value objects that own their native
handles, close idempotently, and act as context managers.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
from typing import TYPE_CHECKING, Final, final

if TYPE_CHECKING:
    from types import TracebackType

from hubfetch.platform.windows.job_object_errors import (
    AssignProcessError,
    CreateJobObjectError,
    JobObjectClosedError,
    JobObjectError,
    OpenProcessError,
    QueryJobObjectError,
    SetJobInformationError,
    TerminateJobObjectError,
    Win32Error,
)
from hubfetch.platform.windows.job_object_types import (
    ERROR_INVALID_HANDLE,
    JOB_INFOCLASS_BASIC_ACCOUNTING_INFORMATION,
    JOB_INFOCLASS_BASIC_PROCESS_ID_LIST,
    JOB_INFOCLASS_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    PROCESS_SET_QUOTA,
    PROCESS_TERMINATE,
    JobObjectBasicAccountingInformation,
    JobObjectBasicLimitInformation,
    JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation,
    field_offsets,
)
from hubfetch.platform.windows.win32_surface import (
    PROCESS_ID_ENTRY_SIZE,
    PROCESS_ID_LIST_CAPACITY,
    kernel32_surface,
    read_dword,
    read_size,
    write_dword,
)

_win32 = kernel32_surface


def open_process(pid: int) -> ProcessHandle:
    """Open a process with only the rights required for job assignment."""
    inherit_handle = False
    raw_handle = _win32.open_process(
        PROCESS_SET_QUOTA | PROCESS_TERMINATE, inherit_handle, pid
    )
    if not raw_handle:
        raise OpenProcessError(operation="OpenProcess", code=ctypes.get_last_error())
    return ProcessHandle(raw_handle, pid)


@final
class ProcessHandle:
    """Owns one OpenProcess handle with idempotent close and context management."""

    __slots__: Final = ("_pid", "_raw_handle")
    _raw_handle: int | None
    _pid: int

    def __init__(self, raw_handle: int, pid: int) -> None:
        """Own the given native handle for the given process identifier."""
        self._raw_handle = raw_handle
        self._pid = pid

    @property
    def pid(self) -> int:
        """Return the process identifier captured at open time."""
        return self._pid

    @property
    def raw_handle(self) -> int | None:
        """Return the native handle value; the adapter's internal assign channel."""
        return self._raw_handle

    @property
    def is_open(self) -> bool:
        """Return whether a native handle is still held."""
        return self._raw_handle is not None

    def close(self) -> None:
        """Close the native handle; repeated close is a no-op."""
        if self._raw_handle is None:
            return
        _win32.close_handle(self._raw_handle)
        self._raw_handle = None

    def __enter__(self) -> ProcessHandle:
        """Enter the process-handle context."""
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Close the handle when leaving the context."""
        self.close()


@final
class JobObject:
    """Owns a kill-on-close Windows Job Object with idempotent close."""

    __slots__: Final = ("_raw_handle",)
    _raw_handle: int | None

    def __init__(self) -> None:
        """Create an unnamed kill-on-close Job Object."""
        raw_handle = _win32.create_job_object(None, None)
        if not raw_handle:
            raise CreateJobObjectError(
                operation="CreateJobObjectW", code=ctypes.get_last_error()
            )
        self._raw_handle = raw_handle
        self._apply_kill_on_close()

    def _apply_kill_on_close(self) -> None:
        """Configure JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE on the fresh job."""
        limit = JobObjectExtendedLimitInformation()
        extended_offsets = field_offsets(JobObjectExtendedLimitInformation)
        basic_offsets = field_offsets(JobObjectBasicLimitInformation)
        limit_flags_offset = (
            extended_offsets["BasicLimitInformation"] + basic_offsets["LimitFlags"]
        )
        write_dword(
            ctypes.addressof(limit),
            limit_flags_offset,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        )
        ok = _win32.set_information_job_object(
            self._raw_handle,
            JOB_INFOCLASS_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(limit),
            ctypes.sizeof(JobObjectExtendedLimitInformation),
        )
        if not ok:
            raise SetJobInformationError(
                operation="SetInformationJobObject", code=ctypes.get_last_error()
            )

    @property
    def is_open(self) -> bool:
        """Return whether the job handle is still held."""
        return self._raw_handle is not None

    def assign(self, process: ProcessHandle) -> None:
        """Assign one opened process to this job; closed handles raise typed errors."""
        handle = self._raw()
        process_handle = process.raw_handle
        if process_handle is None:
            raise AssignProcessError(
                operation="AssignProcessToJobObject", code=ERROR_INVALID_HANDLE
            )
        ok = _win32.assign_process_to_job_object(handle, process_handle)
        if not ok:
            raise AssignProcessError(
                operation="AssignProcessToJobObject", code=ctypes.get_last_error()
            )

    def active_process_count(self) -> int:
        """Return the number of processes currently active in the job."""
        handle = self._raw()
        info = JobObjectBasicAccountingInformation()
        returned = wintypes.DWORD(0)
        ok = _win32.query_information_job_object(
            handle,
            JOB_INFOCLASS_BASIC_ACCOUNTING_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
            ctypes.byref(returned),
        )
        if not ok:
            raise QueryJobObjectError(
                operation="QueryInformationJobObject", code=ctypes.get_last_error()
            )
        offsets = field_offsets(JobObjectBasicAccountingInformation)
        return read_dword(ctypes.addressof(info), offsets["ActiveProcesses"])

    def active_process_ids(self) -> tuple[int, ...]:
        """Return the PIDs of every process currently in the job."""
        handle = self._raw()
        capacity = PROCESS_ID_LIST_CAPACITY
        buffer = (ctypes.c_ubyte * (8 + capacity * PROCESS_ID_ENTRY_SIZE))()
        returned = wintypes.DWORD(0)
        ok = _win32.query_information_job_object(
            handle,
            JOB_INFOCLASS_BASIC_PROCESS_ID_LIST,
            ctypes.byref(buffer),
            ctypes.sizeof(buffer),
            ctypes.byref(returned),
        )
        if not ok:
            raise QueryJobObjectError(
                operation="QueryInformationJobObject", code=ctypes.get_last_error()
            )
        offsets = field_offsets(JobObjectBasicProcessIdList)
        count = read_dword(
            ctypes.addressof(buffer), offsets["NumberOfProcessIdsInList"]
        )
        ids: list[int] = []
        for index in range(count):
            entry_offset = offsets["ProcessIdList"] + index * PROCESS_ID_ENTRY_SIZE
            ids.append(read_size(ctypes.addressof(buffer), entry_offset))
        return tuple(ids)

    def terminate(self) -> None:
        """Terminate every job member; empty-job convergence is caller-observed."""
        handle = self._raw()
        ok = _win32.terminate_job_object(handle, 0)
        if not ok:
            raise TerminateJobObjectError(
                operation="TerminateJobObject", code=ctypes.get_last_error()
            )

    def close(self) -> None:
        """Close the job handle, firing kill-on-close; repeated close is a no-op."""
        if self._raw_handle is None:
            return
        _win32.close_handle(self._raw_handle)
        self._raw_handle = None

    def __enter__(self) -> JobObject:
        """Enter the job context."""
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Close the job when leaving the context."""
        self.close()

    def _raw(self) -> int:
        """Return the open handle, raising a typed error once the job is closed."""
        handle = self._raw_handle
        if handle is None:
            raise JobObjectClosedError(operation="JobObject", code=ERROR_INVALID_HANDLE)
        return handle


__all__: Final = (
    "AssignProcessError",
    "CreateJobObjectError",
    "JobObject",
    "JobObjectClosedError",
    "JobObjectError",
    "OpenProcessError",
    "ProcessHandle",
    "QueryJobObjectError",
    "SetJobInformationError",
    "TerminateJobObjectError",
    "Win32Error",
    "open_process",
)
