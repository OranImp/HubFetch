"""Win32 Job Object constants and structure layouts for x64 Windows.

Every structure here mirrors a documented Win32 type; the class name uses the
project's CapWords convention while the docstring names the exact Win32 type.
Structure sizes and field offsets are verified against the documented ABI by
``tests/platform/windows/test_job_object.py``. Layout notes:

- ``JOBOBJECT_BASIC_LIMIT_INFORMATION`` and the accounting structures use
  natural alignment (x64 sizes 64, 144, and 48 bytes).
- ``JOBOBJECT_BASIC_PROCESS_ID_LIST`` is wrapped in ``pshpack4`` in winnt.h,
  so its ``ULONG_PTR`` array starts at byte offset 8 and the structure is
  16 bytes regardless of pointer width.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
from typing import Final, final

# Job Object desired-access rights passed to CreateJobObjectW.
JOB_OBJECT_ASSIGN_PROCESS: Final = 0x0001
JOB_OBJECT_SET_ATTRIBUTES: Final = 0x0002
JOB_OBJECT_QUERY: Final = 0x0004
JOB_OBJECT_TERMINATE: Final = 0x0008
JOB_OBJECT_OPERATION_ACCESS: Final = (
    JOB_OBJECT_ASSIGN_PROCESS
    | JOB_OBJECT_SET_ATTRIBUTES
    | JOB_OBJECT_QUERY
    | JOB_OBJECT_TERMINATE
)

# Job Object information classes for Set/QueryInformationJobObject.
JOB_INFOCLASS_BASIC_ACCOUNTING_INFORMATION: Final = 1
JOB_INFOCLASS_BASIC_PROCESS_ID_LIST: Final = 3
JOB_INFOCLASS_EXTENDED_LIMIT_INFORMATION: Final = 9

# Limit flags for JOBOBJECT_BASIC_LIMIT_INFORMATION.
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Final = 0x2000

# Process desired-access rights passed to OpenProcess; the minimal set that
# AssignProcessToJobObject requires for a successful assignment.
PROCESS_TERMINATE: Final = 0x0001
PROCESS_SET_QUOTA: Final = 0x0100

# Error codes surfaced as typed exception fields; never embedded in messages.
ERROR_INVALID_HANDLE: Final = 6
ERROR_INVALID_PARAMETER: Final = 87
ERROR_ACCESS_DENIED: Final = 5
ERROR_MORE_DATA: Final = 234


@final
class JobObjectBasicLimitInformation(ctypes.Structure):
    """JOBOBJECT_BASIC_LIMIT_INFORMATION with natural x64 alignment (64 bytes)."""

    _fields_ = [
        ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
        ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


@final
class IoCounters(ctypes.Structure):
    """IO_COUNTERS, six 64-bit counters with natural alignment (48 bytes)."""

    _fields_ = [
        ("ReadOperationCount", wintypes.ULARGE_INTEGER),
        ("WriteOperationCount", wintypes.ULARGE_INTEGER),
        ("OtherOperationCount", wintypes.ULARGE_INTEGER),
        ("ReadTransferCount", wintypes.ULARGE_INTEGER),
        ("WriteTransferCount", wintypes.ULARGE_INTEGER),
        ("OtherTransferCount", wintypes.ULARGE_INTEGER),
    ]


@final
class JobObjectExtendedLimitInformation(ctypes.Structure):
    """JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes on x64)."""

    _fields_ = [
        ("BasicLimitInformation", JobObjectBasicLimitInformation),
        ("IoInfo", IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


@final
class JobObjectBasicAccountingInformation(ctypes.Structure):
    """JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (48 bytes on x64).

    ``ActiveProcesses`` carries the live-process count used for bounded
    empty-job observations and lives at byte offset 40 on x64.
    """

    _fields_ = [
        ("TotalUserTime", wintypes.LARGE_INTEGER),
        ("TotalKernelTime", wintypes.LARGE_INTEGER),
        ("ThisPeriodTotalUserTime", wintypes.LARGE_INTEGER),
        ("ThisPeriodTotalKernelTime", wintypes.LARGE_INTEGER),
        ("TotalPageFaultCount", wintypes.DWORD),
        ("TotalProcesses", wintypes.DWORD),
        ("ActiveProcesses", wintypes.DWORD),
        ("TotalTerminatedProcesses", wintypes.DWORD),
    ]


@final
class JobObjectBasicProcessIdList(ctypes.Structure):
    """JOBOBJECT_BASIC_PROCESS_ID_LIST, packed to 4 bytes (16 bytes on x64).

    winnt.h wraps this structure in ``pshpack4``; the PID array therefore
    starts at byte offset 8 and the header occupies only 8 bytes.
    """

    _pack_ = 4

    _fields_ = [
        ("NumberOfAssignedProcesses", wintypes.DWORD),
        ("NumberOfProcessIdsInList", wintypes.DWORD),
        ("ProcessIdList", ctypes.c_size_t * 1),
    ]


def field_offsets(structure: type[ctypes.Structure]) -> dict[str, int]:
    """Return every member's byte offset for the current architecture.

    Offsets are computed from the structure's declared fields honoring its
    ``_pack_`` value; structures without ``_pack_`` use natural alignment.
    The adapter reads query results out of raw ctypes memory at these offsets
    because direct field reads are typed as ``Any``.
    """
    pack = int(getattr(structure, "_pack_", 0) or 0)
    offset = 0
    result: dict[str, int] = {}
    for item in structure._fields_:
        name: str = item[0]
        field_type = item[1]
        alignment = ctypes.alignment(field_type)
        if pack:
            alignment = min(alignment, pack)
        offset = (offset + alignment - 1) // alignment * alignment
        result[name] = offset
        offset += ctypes.sizeof(field_type)
    return result
