"""Typed Win32 errors for the Job Object containment boundary.

Every error carries the failed operation and the raw ``GetLastError`` code as
typed fields. The human message never embeds the raw code: it is a stable
sanitized phrase so diagnostics cannot leak numeric Win32 detail.
"""

from __future__ import annotations

from typing import Final


class Win32Error(OSError):
    """A Win32 call failed; the raw error code is typed, never embedded in text."""

    operation: str
    code: int

    def __init__(self, *, operation: str, code: int) -> None:
        """Record the failed Win32 operation and its typed error code."""
        self.operation = operation
        self.code = code
        super().__init__(f"{operation} failed")


class OpenProcessError(Win32Error):
    """OpenProcess failed; no process handle was created."""


class JobObjectError(Win32Error):
    """A Job Object operation failed; the job state is unchanged."""


class CreateJobObjectError(JobObjectError):
    """CreateJobObjectW failed; no job handle was created."""


class SetJobInformationError(JobObjectError):
    """SetInformationJobObject failed; kill-on-close was not configured."""


class AssignProcessError(JobObjectError):
    """AssignProcessToJobObject failed; the process was not contained."""


class QueryJobObjectError(JobObjectError):
    """QueryInformationJobObject failed; no state was returned."""


class TerminateJobObjectError(JobObjectError):
    """TerminateJobObject failed; job members may still be running."""


class JobObjectClosedError(JobObjectError):
    """An operation required an open job handle that was already closed."""


__all__: Final = (
    "AssignProcessError",
    "CreateJobObjectError",
    "JobObjectClosedError",
    "JobObjectError",
    "OpenProcessError",
    "QueryJobObjectError",
    "SetJobInformationError",
    "TerminateJobObjectError",
    "Win32Error",
)
