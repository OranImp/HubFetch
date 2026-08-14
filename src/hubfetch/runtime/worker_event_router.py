"""Parses worker stdout frames and drives the ready/terminal state machine.

The router owns the incremental :class:`JsonlEventReader` plus the handshake
ordering the reader does not enforce: ``worker_ready`` must arrive first and
exactly once, and every later event is routed as terminal or not. Protocol
violations surface as typed :class:`TransportProtocolError` codes so the
transport reports them unchanged through ``preflight_failed``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, final

from hubfetch.domain.ipc import (
    CancelledEvent,
    FailedEvent,
    SucceededEvent,
    WorkerReadyEvent,
)
from hubfetch.runtime.jsonl_transport import (
    MAX_LINE_BYTES,
    MAX_TOTAL_BYTES,
    JsonlEventReader,
    TransportProtocolError,
)


@dataclass(frozen=True, slots=True)
class RoutedEvent:
    """One handshake-routed worker event with its terminal flag."""

    kind: str
    terminal: bool


@final
class WorkerEventRouter:
    """Incremental event parser enforcing ready-before-everything ordering."""

    __slots__: Final = ("_reader", "_ready")

    def __init__(
        self,
        *,
        max_line_bytes: int = MAX_LINE_BYTES,
        max_total_bytes: int = MAX_TOTAL_BYTES,
    ) -> None:
        """Create a router with the given line and total byte limits."""
        self._reader = JsonlEventReader(
            max_line_bytes=max_line_bytes, max_total_bytes=max_total_bytes
        )
        self._ready = False

    @property
    def ready(self) -> bool:
        """Return whether the worker has emitted its one ``worker_ready``."""
        return self._ready

    def feed(self, chunk: bytes) -> tuple[RoutedEvent, ...]:
        """Parse one stdout chunk and route every event it completes."""
        routed: list[RoutedEvent] = []
        for frame in self._reader.feed(chunk):
            event = frame.event
            if isinstance(event, WorkerReadyEvent):
                if self._ready:
                    raise TransportProtocolError(
                        code="duplicate_ready",
                        detail="the worker emitted worker_ready twice",
                    )
                self._ready = True
                routed.append(RoutedEvent(kind=event.kind, terminal=False))
                continue
            if not self._ready:
                raise TransportProtocolError(
                    code="unexpected_before_ready",
                    detail=f"the worker emitted {event.kind!r} before worker_ready",
                )
            routed.append(
                RoutedEvent(
                    kind=event.kind,
                    terminal=isinstance(
                        event, (SucceededEvent, FailedEvent, CancelledEvent)
                    ),
                )
            )
        return tuple(routed)
