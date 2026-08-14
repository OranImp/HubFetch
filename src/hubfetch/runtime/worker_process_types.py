"""Typed outcomes and defaults for the worker QProcess transport."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, override

DEFAULT_READY_TIMEOUT_MS: Final = 30_000
"""Default bound the worker has to emit ``worker_ready``."""


@dataclass(frozen=True, slots=True)
class PreflightFailure:
    """A typed preflight outcome the runtime can persist later."""

    code: str
    detail: str
    pid: int | None = None


@dataclass(frozen=True, slots=True)
class WorkerProcessStateError(RuntimeError):
    """A transport step was attempted in an illegal handshake state."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"worker transport state error: {self.reason}"
