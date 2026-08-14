"""Bounded-rate typed progress bridge for the pinned Hub download APIs.

The pinned ``huggingface_hub`` 1.27.0 library renders download progress through
a ``tqdm_class`` it instantiates itself with a fixed keyword surface (pinned by
``tests/hub/test_progress.py``). :class:`LibraryProgressBar` is that duck-typed
bar; :class:`ProgressSink` is the typed accumulator it feeds: it aggregates the
library's byte bars and the snapshot file-count bar into bounded-rate,
monotonic, sanitized :class:`ProgressUpdate` samples and raises a typed
cancellation at every checkpoint.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal, Self, final

from hubfetch.domain.errors import ErrorCategory, error_for
from hubfetch.domain.lifecycle import TransferStage

if TYPE_CHECKING:
    from collections.abc import Callable

    from hubfetch.security.redaction import Redactor

BarRole = Literal["bytes", "files"]

_AGGREGATE_DESCRIPTIONS: Final[frozenset[str]] = frozenset(
    {"Downloading bytes", "Reconstructing (incomplete total...)"}
)
# Snapshot aggregate-bar descriptions that never name a repository file.

# Bar roles follow the pinned library's construction contract: byte bars are
# always created with ``unit="B"`` (the single-file bar and the snapshot
# transfer/reconstruct bars), while the snapshot's outer file-count bar is
# created without a unit (default ``"it"``). Because the transfer and reconstruct
# bars observe the same byte stream, only the first-created byte bar contributes
# to byte accounting.


@dataclass(frozen=True, slots=True)
class ProgressUpdate:
    """One bounded-rate typed progress sample emitted by the sink."""

    stage: TransferStage
    bytes_done: int
    bytes_total: int | None
    files_done: int
    files_total: int | None
    current_path: str | None
    bytes_per_second: float | None
    completed: bool


@dataclass(slots=True)
class _BarBinding:
    role: BarRole
    n: int
    total: int | None


@final
class ProgressSink:
    """Aggregate library progress callbacks into bounded-rate typed samples.

    ``emit`` receives each :class:`ProgressUpdate` and is wired by the worker
    handler to the Todo 14 wire writer. ``interval_seconds`` bounds non-final
    samples (the first and every ``complete()`` sample always emit); ``clock``,
    ``redactor``, and ``cancel`` are the injectable time, sanitization, and
    cooperative-cancellation seams.
    """

    def __init__(
        self,
        *,
        emit: Callable[[ProgressUpdate], None],
        interval_seconds: float = 0.1,
        clock: Callable[[], float] | None = None,
        redactor: Redactor | None = None,
        cancel: Callable[[], bool] | None = None,
    ) -> None:
        """Bind the emit callback, rate interval, clock, redactor, and probe."""
        self._emit = emit
        self._interval_seconds = interval_seconds
        self._clock = clock if clock is not None else time.monotonic
        self._redactor = redactor
        self._cancel = cancel
        self._lock = threading.Lock()
        self._bars: dict[int, _BarBinding] = {}
        self._bar_index = 0
        self._winning_byte_bar: int | None = None
        self._bytes_done = 0
        self._bytes_total: int | None = None
        self._files_done = 0
        self._files_total: int | None = None
        self._current_path: str | None = None
        self._stage = TransferStage.TRANSFER
        self._last_emit_time: float | None = None
        self._last_sample_bytes = 0
        self._emitted_bytes = 0

    def begin(self, stage: TransferStage) -> None:
        """Set the transfer stage carried by subsequent samples."""
        self._stage = stage

    def checkpoint(self) -> None:
        """Raise a typed cancellation when the cooperative probe is set."""
        self._check_cancel()

    def set_current_path(self, path: str) -> None:
        """Record a sanitized relative path as the current transfer target."""
        with self._lock:
            self._current_path = (
                self._redactor.redact_text(path) if self._redactor else path
            )

    def complete(self) -> None:
        """Force one final completed sample, unless cancellation already won."""
        self._check_cancel()
        with self._lock:
            self._emit_sample(self._clock(), completed=True)

    def bar_class(self) -> type[LibraryProgressBar]:
        """Return a bar class permanently bound to this sink."""

        class BoundLibraryProgressBar(LibraryProgressBar):
            _sink: ProgressSink = self

        return BoundLibraryProgressBar

    def register_bar(
        self,
        *,
        role: BarRole,
        total: int | None,
        desc: str | None,
        initial: int,
    ) -> int:
        """Register one library-created bar and return its stable index."""
        with self._lock:
            index = self._bar_index
            self._bar_index += 1
            self._bars[index] = _BarBinding(role=role, n=initial, total=total)
            if role == "bytes" and self._winning_byte_bar is None:
                self._winning_byte_bar = index
                if desc is not None and desc not in _AGGREGATE_DESCRIPTIONS:
                    self._current_path = (
                        self._redactor.redact_text(desc) if self._redactor else desc
                    )
            if total is not None:
                self._grow_totals(role, total)
            return index

    def report(self, index: int, n: int, total: int | None) -> None:
        """Consume one bar report and emit a sample when the rate allows."""
        self._check_cancel()
        with self._lock:
            binding = self._bars[index]
            binding.n = max(binding.n, n)
            if total is not None:
                binding.total = total
                self._grow_totals(binding.role, total)
            if binding.role == "files":
                self._files_done = binding.n
            if binding.role == "bytes" and index == self._winning_byte_bar:
                self._bytes_done = binding.n
            if self._last_emit_time is None or (
                self._clock() - self._last_emit_time >= self._interval_seconds
            ):
                self._emit_sample(self._clock(), completed=False)

    def _grow_totals(self, role: BarRole, total: int) -> None:
        # Grow the known byte/file total to at least the observed value.
        if role == "bytes":
            self._bytes_total = max(self._bytes_total or 0, total)
        else:
            self._files_total = max(self._files_total or 0, total)

    def _emit_sample(self, now: float, *, completed: bool) -> None:
        """Build and emit one sample, flooring bytes so the wire stays monotonic."""
        last = self._last_emit_time
        elapsed = now - last if last is not None else 0.0
        speed: float | None = None
        if elapsed > 0:
            delta = self._bytes_done - self._last_sample_bytes
            if delta > 0:
                speed = delta / elapsed
        emitted_bytes = max(self._bytes_done, self._emitted_bytes)
        self._emitted_bytes = emitted_bytes
        self._last_emit_time = now
        self._last_sample_bytes = self._bytes_done
        self._emit(
            ProgressUpdate(
                stage=self._stage,
                bytes_done=emitted_bytes,
                bytes_total=self._bytes_total,
                files_done=self._files_done,
                files_total=self._files_total,
                current_path=self._current_path,
                bytes_per_second=speed,
                completed=completed,
            )
        )

    # A cooperative cancel raises the typed error so the library call unwinds.
    def _check_cancel(self) -> None:
        if self._cancel is not None and self._cancel():
            raise error_for(ErrorCategory.CANCELLATION)


class LibraryProgressBar:
    """Duck-typed tqdm replacement the pinned library instantiates as ``tqdm_class``.

    Never constructed directly: :meth:`ProgressSink.bar_class` returns a
    subclass bound to its sink (so this class is deliberately not ``@final``).
    The pinned library passes exactly the six keyword arguments declared here
    and drives each bar through the context manager, ``update``,
    ``update_transfer``, the ``set_*_postfix_str``/``set_description`` methods,
    ``refresh``, ``close``, and the mutable ``n``/``total``/``format_dict``
    state. A bar whose ``unit`` is ``"B"`` reports bytes; any other reports
    completed files.
    """

    _sink: ProgressSink
    _index: int
    _transfer_n: int
    _update_n: int
    format_dict: dict[str, float | None]
    n: int
    total: int | None

    def __init__(  # noqa: PLR0913 - mirrors the pinned library's six bar kwargs
        self,
        desc: str | None = None,
        *,
        total: int | None = None,
        initial: int = 0,
        unit: str = "it",
        unit_scale: bool = True,
        bar_format: str | None = None,
    ) -> None:
        """Register with the bound sink and flatten the update/transfer channels."""
        del unit_scale, bar_format
        self.n = initial
        self.total = total
        self.format_dict = {}
        self._update_n = initial
        self._transfer_n = initial
        sink = self._sink
        self._sink = sink
        self._index = sink.register_bar(
            role="bytes" if unit == "B" else "files",
            total=total,
            desc=desc,
            initial=initial,
        )

    def __enter__(self) -> Self:
        """Return the bar for the library's ``with`` usage."""
        return self

    def __exit__(self, *exc: object) -> None:
        """Close the bar on context exit; the sink's complete() emits the sample."""
        del exc
        self.close()

    def close(self) -> None:
        """No-op: the sink's :meth:`ProgressSink.complete` emits the final sample."""

    def update(self, n: int) -> None:
        """Accumulate one byte (or file) update and report it to the sink."""
        self._update_n += n
        self._sync()

    def update_transfer(self, n: int) -> None:
        """Accumulate one network-transfer byte and report it to the sink."""
        self._transfer_n += n
        self._sync()

    def set_postfix_str(self, postfix: str, refresh: bool = False) -> None:
        """Discard the library's postfix; the sink computes its own speed."""
        del postfix, refresh
        self._sync()

    def set_transfer_postfix_str(self, postfix: str, refresh: bool = False) -> None:
        """Discard the library's transfer postfix; the sink tracks bytes itself."""
        del postfix, refresh
        self._sync()

    def set_description(self, desc: str) -> None:
        """Discard phase descriptions (e.g. ``Download complete``) as non-paths."""
        del desc
        self._sync()

    def refresh(self) -> None:
        """Report the current cumulative state to the sink (a cancel checkpoint)."""
        self._sync()

    def _sync(self) -> None:
        """Flatten the two channels, then report; negatives never decrease."""
        self.n = max(self._update_n, self._transfer_n)
        self._sink.report(self._index, self.n, self.total)


__all__: Final = ("LibraryProgressBar", "ProgressSink", "ProgressUpdate")
