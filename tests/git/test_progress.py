"""Tests for parsing documented Git clone progress records.

Only Git's documented progress lines are parsed into typed phases; every other
stderr line becomes a sanitized diagnostic. A secret-bearing line must be
redacted before it is retained as a diagnostic.
"""

from __future__ import annotations

from typing import Final

from hubfetch.git.progress import (
    GitProgressRecord,
    ParsedProgress,
    ProgressPhase,
    parse_progress_line,
    parse_progress_stderr,
)
from hubfetch.security.redaction import Redactor

SECRET: Final = "hf_test_secret_123"  # noqa: S105

_CLONING_STDERR: Final = (
    "Cloning into 'C:\\work\\model'...\n"
    "remote: Total 3 (delta 0), reused 0 (delta 0), pack-reused 0\n"
)
_MIXED_STDERR: Final = (
    "Cloning into 'dest'...\n"
    "remote: Enumerating objects: 5, done.\n"
    "Receiving objects: 100% (5/5), done.\n"
)


class TestParseProgressLine:
    """Each documented Git progress record maps to one typed phase."""

    def test_enumerating_objects_record(self) -> None:
        """Given a remote enumerate line, it parses to the enumerating phase."""
        record = parse_progress_line("remote: Enumerating objects: 42, done.")

        assert record == GitProgressRecord(
            phase=ProgressPhase.ENUMERATING, done=42, total=42, rate=None
        )

    def test_counting_objects_record(self) -> None:
        """Given a counting line, it parses to the counting phase."""
        record = parse_progress_line("remote: Counting objects: 50% (3/6), done.")

        assert record == GitProgressRecord(
            phase=ProgressPhase.COUNTING, done=3, total=6, rate=None
        )

    def test_compressing_objects_record(self) -> None:
        """Given a compressing line, it parses to the compressing phase."""
        record = parse_progress_line("remote: Compressing objects: 100% (2/2), done.")

        assert record == GitProgressRecord(
            phase=ProgressPhase.COMPRESSING, done=2, total=2, rate=None
        )

    def test_receiving_objects_record_with_rate(self) -> None:
        """Given a receiving line with a rate, the rate is retained verbatim."""
        record = parse_progress_line(
            "Receiving objects:  33% (1/3), 1.00 MiB | 512.00 KiB/s"
        )

        assert record == GitProgressRecord(
            phase=ProgressPhase.RECEIVING,
            done=1,
            total=3,
            rate="1.00 MiB | 512.00 KiB/s",
        )

    def test_receiving_objects_final_record(self) -> None:
        """Given a completed receiving line, the trailing done marker is dropped."""
        record = parse_progress_line(
            "Receiving objects: 100% (3/3), 1.10 MiB | 1.20 MiB/s, done."
        )

        assert record == GitProgressRecord(
            phase=ProgressPhase.RECEIVING,
            done=3,
            total=3,
            rate="1.10 MiB | 1.20 MiB/s",
        )

    def test_resolving_deltas_record(self) -> None:
        """Given a resolving line, it parses to the resolving phase."""
        record = parse_progress_line("Resolving deltas: 50% (1/2)")

        assert record == GitProgressRecord(
            phase=ProgressPhase.RESOLVING, done=1, total=2, rate=None
        )

    def test_updating_files_record(self) -> None:
        """Given an updating line, it parses to the updating phase."""
        record = parse_progress_line("Updating files: 100% (4/4), done.")

        assert record == GitProgressRecord(
            phase=ProgressPhase.UPDATING, done=4, total=4, rate=None
        )

    def test_unprefixed_local_record(self) -> None:
        """Given a local (non-remote) line, it parses without the prefix."""
        record = parse_progress_line("Receiving objects: 100% (3/3), done.")

        assert record is not None
        assert record.phase is ProgressPhase.RECEIVING


class TestUnparsedDiagnostics:
    """Unparsed stderr lines are retained only as sanitized diagnostics."""

    def test_unparsed_line_is_retained_as_diagnostic(self) -> None:
        """Given a non-progress line, parsing keeps it as a diagnostic."""
        parsed = parse_progress_stderr(_CLONING_STDERR, redactor=Redactor())

        assert parsed.records == ()
        assert "Cloning into 'C:\\work\\model'..." in parsed.diagnostics
        assert any(
            "remote: Total 3 (delta 0), reused 0 (delta 0)" in line
            for line in parsed.diagnostics
        )

    def test_diagnostic_line_redacts_secrets(self) -> None:
        """Given a secret-bearing line, the diagnostic is redacted."""
        parsed = parse_progress_stderr(
            f"fatal: unable to access 'https://user:{SECRET}@huggingface.co': boom\n",
            redactor=Redactor(),
        )

        assert len(parsed.diagnostics) == 1
        assert SECRET not in parsed.diagnostics[0]
        assert "[REDACTED]" in parsed.diagnostics[0]

    def test_parse_stderr_collects_records_and_diagnostics(self) -> None:
        """Given mixed stderr, records and diagnostics are separated."""
        parsed = parse_progress_stderr(_MIXED_STDERR, redactor=Redactor())

        assert parsed == ParsedProgress(
            records=(
                GitProgressRecord(
                    phase=ProgressPhase.ENUMERATING, done=5, total=5, rate=None
                ),
                GitProgressRecord(
                    phase=ProgressPhase.RECEIVING, done=5, total=5, rate=None
                ),
            ),
            diagnostics=("Cloning into 'dest'...",),
        )

    def test_parse_stderr_without_redactor_keeps_structural_lines(self) -> None:
        """Given no redactor, diagnostics are still separated from records."""
        parsed = parse_progress_stderr("Receiving objects: 50% (2/4)")

        assert len(parsed.records) == 1
        assert parsed.diagnostics == ()
