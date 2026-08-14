"""Fully typed low-level surface over the kernel32 Job Object Win32 API.

This module is the single isolation boundary for Win32 calls. ``kernel32`` is
loaded once with ``use_last_error=True``, every function pointer is declared
with exact ``argtypes``/``restype``, and ``Kernel32Surface`` binds each one to a
fully typed ``Callable`` signature so no call site ever sees an ``Any``.

The names here are public but the module is internal to the containment
adapter: the ``hubfetch.platform.windows`` package does not re-export them, and
``job_object.py`` is the only consumer. Raw handle integers returned by the
facade never cross ``job_object.py``'s public API.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
from typing import TYPE_CHECKING, Final, final

if TYPE_CHECKING:
    from collections.abc import Callable

_kernel32: Final = ctypes.WinDLL("kernel32", use_last_error=True)

_kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
_kernel32.CreateJobObjectW.restype = wintypes.HANDLE
_kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_kernel32.OpenProcess.restype = wintypes.HANDLE
_kernel32.SetInformationJobObject.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    ctypes.c_void_p,
    wintypes.DWORD,
]
_kernel32.SetInformationJobObject.restype = wintypes.BOOL
_kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
_kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
_kernel32.QueryInformationJobObject.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    ctypes.c_void_p,
    wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD),
]
_kernel32.QueryInformationJobObject.restype = wintypes.BOOL
_kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
_kernel32.TerminateJobObject.restype = wintypes.BOOL
_kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
_kernel32.CloseHandle.restype = wintypes.BOOL

PROCESS_ID_LIST_CAPACITY: Final = 64
PROCESS_ID_ENTRY_SIZE: Final = ctypes.sizeof(ctypes.c_size_t)


def read_dword(source_address: int, offset: int) -> int:
    """Read one little-endian DWORD from ctypes memory at a byte offset."""
    value = wintypes.DWORD()
    ctypes.memmove(
        ctypes.byref(value),
        source_address + offset,
        ctypes.sizeof(value),
    )
    return int(value.value)


def read_size(source_address: int, offset: int) -> int:
    """Read one little-endian pointer-sized value from ctypes memory."""
    value = ctypes.c_size_t()
    ctypes.memmove(
        ctypes.byref(value),
        source_address + offset,
        ctypes.sizeof(value),
    )
    return int(value.value)


def write_dword(target_address: int, offset: int, value: int) -> None:
    """Write one little-endian DWORD into ctypes memory at a byte offset."""
    payload = wintypes.DWORD(value)
    ctypes.memmove(
        target_address + offset,
        ctypes.byref(payload),
        ctypes.sizeof(payload),
    )


@final
class Kernel32Surface:
    """Typed facade over the kernel32 function pointers used by the adapter."""

    __slots__: Final = ("_dll",)
    _dll: ctypes.WinDLL

    def __init__(self, dll: ctypes.WinDLL) -> None:
        """Bind the facade to the loaded kernel32 WinDLL."""
        self._dll = dll

    @property
    def create_job_object(self) -> Callable[[object, object], int | None]:
        """Bind CreateJobObjectW; NULL maps to None on failure."""
        return self._dll.CreateJobObjectW

    @property
    def open_process(self) -> Callable[[int, bool, int], int | None]:
        """Bind OpenProcess; NULL maps to None on failure."""
        return self._dll.OpenProcess

    @property
    def set_information_job_object(self) -> Callable[[object, int, object, int], bool]:
        """Bind SetInformationJobObject; returns success as a boolean."""
        return self._dll.SetInformationJobObject

    @property
    def assign_process_to_job_object(self) -> Callable[[object, object], bool]:
        """Bind AssignProcessToJobObject; returns success as a boolean."""
        return self._dll.AssignProcessToJobObject

    @property
    def query_information_job_object(
        self,
    ) -> Callable[[object, int, object, int, object], bool]:
        """Bind QueryInformationJobObject; returns success as a boolean."""
        return self._dll.QueryInformationJobObject

    @property
    def terminate_job_object(self) -> Callable[[object, int], bool]:
        """Bind TerminateJobObject; returns success as a boolean."""
        return self._dll.TerminateJobObject

    @property
    def close_handle(self) -> Callable[[object], bool]:
        """Bind CloseHandle; returns success as a boolean."""
        return self._dll.CloseHandle


kernel32_surface: Final = Kernel32Surface(_kernel32)

__all__: Final = (
    "PROCESS_ID_ENTRY_SIZE",
    "PROCESS_ID_LIST_CAPACITY",
    "Kernel32Surface",
    "kernel32_surface",
    "read_dword",
    "read_size",
    "write_dword",
)
