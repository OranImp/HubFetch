# pyright: reportPrivateUsage = false
# pyright: reportUnknownVariableType = false
# pyright: reportUnknownMemberType = false
# pyright: reportUnknownArgumentType = false
# pyright: reportArgumentType = false
# pyright: reportAny = false
"""Progress bridge tests: the pinned library's tqdm duck-type contract.

Given/When/Then throughout. These tests pin the exact surface the pinned
``huggingface_hub`` 1.27.0 library exercises on a ``tqdm_class`` it
instantiates, then prove the ``ProgressSink`` aggregation produces bounded-rate,
monotonic, sanitized typed samples and raises a typed cancellation at progress
checkpoints. No network and no wall-clock reads: a controllable clock drives
the rate limiter.

The ``pyright`` directives mirror the ones in ``hubfetch.hub.adapter`` and
``tests/hub/test_contracts.py``: the 1.27.0 stubs type the library's progress
creator and ``tqdm_class`` with unknown tqdm parameters, and this module exists
precisely to introspect that private creator, so the unknown/argument/Any
diagnostics are relaxed in exactly this module.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Final, final

import pytest
from huggingface_hub.utils.tqdm import _create_progress_bar

from hubfetch.domain.errors import CancellationError
from hubfetch.domain.lifecycle import TransferStage
from hubfetch.hub.progress import LibraryProgressBar, ProgressSink, ProgressUpdate
from hubfetch.security.redaction import Redactor

if TYPE_CHECKING:
    from collections.abc import Callable

START_TIME: Final = 100.0
INTERVAL: Final = 1.0


@final
class _MutableClock:
    """A controllable wall-clock stand-in returning the current instant."""

    __slots__: Final = ("_now",)
    _now: float

    def __init__(self, start: float = START_TIME) -> None:
        self._now = start

    def __call__(self) -> float:
        return self._now

    def advance(self, delta: float) -> float:
        self._now += delta
        return self._now


def _samples() -> list[ProgressUpdate]:
    """Return a fresh collector list the sink can emit into."""
    return []


def _sink(
    collector: list[ProgressUpdate],
    clock: _MutableClock | None = None,
    *,
    interval: float = INTERVAL,
    redactor: Redactor | None = None,
    cancel: Callable[[], bool] | None = None,
) -> ProgressSink:
    """Build a sink with a deterministic clock and optional cancel probe."""
    return ProgressSink(
        emit=collector.append,
        interval_seconds=interval,
        clock=clock or _MutableClock(),
        redactor=redactor,
        cancel=cancel,
    )


class TestLibraryProgressBarContract:
    """Given a bound bar class, the pinned library's tqdm surface is accepted."""

    def test_bar_accepts_pinned_library_kwargs(self) -> None:
        bar_type = _sink(_samples()).bar_class()
        bar = bar_type(
            desc="model.bin",
            total=1024,
            initial=0,
            unit="B",
            unit_scale=True,
            bar_format="{desc}: {bar}",
        )
        assert isinstance(bar, LibraryProgressBar)
        assert bar.total == 1024
        assert bar.n == 0

    def test_bar_is_instantiable_by_the_real_library_creator(self) -> None:
        bar_type = _sink(_samples()).bar_class()
        bar = _create_progress_bar(
            cls=bar_type,
            log_level=logging.ERROR,
            name="huggingface_hub.http_get",
            desc="file.bin",
            total=512,
            initial=0,
            unit="B",
            unit_scale=True,
        )
        assert isinstance(bar, LibraryProgressBar)
        assert bar.total == 512

    def test_bar_is_a_context_manager_with_tqdm_state(self) -> None:
        bar_type = _sink(_samples()).bar_class()
        with bar_type(desc="f", total=10, unit="B") as bar:
            bar.update(4)
            assert bar.n == 4
            bar.set_postfix_str("1.2MB/s", refresh=False)
            bar.set_transfer_postfix_str("1.2MB/s", refresh=False)
            bar.refresh()
            assert isinstance(bar.format_dict, dict)
        bar.close()

    def test_bar_roles_by_unit(self) -> None:
        collector = _samples()
        sink = _sink(collector)
        _ = sink.bar_class()(desc="f", total=10, unit="B")
        _ = sink.bar_class()(desc="Fetching 3 files", total=3)
        sink.complete()
        assert collector[-1].files_total == 3


class TestRateLimitedMonotonicProgress:
    """Given a rate-limited sink, emitted samples are bounded and monotonic."""

    def test_emits_first_and_then_only_after_interval(self) -> None:
        collector = _samples()
        clock = _MutableClock()
        sink = _sink(collector, clock)
        bar = sink.bar_class()(desc="f", total=100, unit="B")
        bar.update(10)
        assert len(collector) == 1
        bar.update(10)
        assert len(collector) == 1  # within the interval: suppressed
        clock.advance(INTERVAL)
        bar.update(10)
        assert len(collector) == 2

    def test_complete_always_emits_a_final_sample(self) -> None:
        collector = _samples()
        sink = _sink(collector, interval=3600.0)
        bar = sink.bar_class()(desc="f", total=100, unit="B")
        bar.update(10)
        sink.complete()
        assert len(collector) == 2
        assert collector[-1].completed is True

    def test_emitted_bytes_never_decrease_across_rollback(self) -> None:
        collector = _samples()
        clock = _MutableClock()
        sink = _sink(collector, clock)
        bar = sink.bar_class()(desc="f", total=100, unit="B")
        bar.update_transfer(50)
        clock.advance(INTERVAL)
        bar.update_transfer(-20)  # server ignored the Range: roll back
        sink.complete()
        sequence = [sample.bytes_done for sample in collector]
        assert sequence == sorted(sequence)

    def test_shared_stream_not_double_counted_on_one_bar(self) -> None:
        collector = _samples()
        sink = _sink(collector, interval=0.0)
        bar = sink.bar_class()(desc="f", total=100, unit="B")
        bar.update(25)
        bar.update_transfer(25)
        bar.update(25)
        bar.update_transfer(25)
        sink.complete()
        assert collector[-1].bytes_done == 50
        assert collector[-1].bytes_total == 100

    def test_reconstruct_transfer_pair_counts_stream_once(self) -> None:
        collector = _samples()
        sink = _sink(collector, interval=0.0)
        transfer = sink.bar_class()(desc="Downloading bytes", total=0, unit="B")
        reconstruct = sink.bar_class()(desc="Reconstructing...", total=0, unit="B")
        transfer.total = 100  # the library grows the transfer bar's hidden total
        reconstruct.update(40)
        transfer.update(40)
        reconstruct.update(60)
        transfer.update(60)
        sink.complete()
        assert collector[-1].bytes_done == 100
        assert collector[-1].bytes_total == 100

    def test_file_bar_counts_completed_files(self) -> None:
        collector = _samples()
        sink = _sink(collector, interval=0.0)
        bar = sink.bar_class()(desc="Fetching 3 files", total=3)
        bar.update(1)
        bar.update(1)
        bar.update(1)
        sink.complete()
        assert collector[-1].files_done == 3
        assert collector[-1].files_total == 3

    def test_samples_carry_the_active_stage(self) -> None:
        collector = _samples()
        sink = _sink(collector, interval=0.0)
        sink.begin(TransferStage.TRANSFER)
        bar = sink.bar_class()(desc="f", total=10, unit="B")
        bar.update(1)
        assert collector[-1].stage == TransferStage.TRANSFER


class TestProgressSanitization:
    """Given a secret-bearing bar description, emitted paths are redacted."""

    def test_current_path_redacts_url_userinfo_and_token_query(self) -> None:
        collector = _samples()
        sink = _sink(
            collector,
            interval=0.0,
            redactor=Redactor(),
        )
        bar = sink.bar_class()(
            desc="https://user:super_secret@example.com/repo/file.bin?token=hf_test_secret_123",
            total=10,
            unit="B",
        )
        bar.update(1)
        sink.complete()
        path = collector[-1].current_path
        assert path is not None
        assert "super_secret" not in path
        assert "hf_test_secret_123" not in path
        assert "[REDACTED]" in path


class TestCancellationCheckpoint:
    """Given a cooperative cancel probe, progress checkpoints raise typed stops."""

    def test_bar_update_raises_cancellation_when_probe_is_true(self) -> None:
        state = {"cancelled": False}
        sink = _sink(_samples(), cancel=lambda: state["cancelled"])
        bar = sink.bar_class()(desc="f", total=10, unit="B")
        state["cancelled"] = True
        with pytest.raises(CancellationError):
            bar.update(1)

    def test_checkpoint_raises_cancellation_when_probe_is_true(self) -> None:
        state = {"cancelled": False}
        sink = _sink(_samples(), cancel=lambda: state["cancelled"])
        sink.checkpoint()
        state["cancelled"] = True
        with pytest.raises(CancellationError):
            sink.checkpoint()

    def test_complete_raises_when_cancelled(self) -> None:
        state = {"cancelled": True}
        sink = _sink(_samples(), cancel=lambda: state["cancelled"])
        with pytest.raises(CancellationError):
            sink.complete()
