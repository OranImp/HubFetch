# noqa: SIZE_OK - one module must own the whole support-bundle boundary: the
# typed allowlist, the deterministic ZIP writer, the version header, the log
# budget, and the fail-closed leak guard; splitting it would scatter the
# serialization contract across modules.

"""Typed support-bundle ZIP export through an explicit include allowlist.

The bundle is built from exactly four kinds of content: app/dependency
versions, sanitized settings, the sanitized diagnostic report, and redacted
log files. Database/WAL/SHM files, task payload dumps, environment dumps,
screenshots, credentials, full credential aliases, and arbitrary cache files
are never candidates because only ``.jsonl`` and ``.log`` files inside the
configured log directory are scanned. Every member passes through the redactor
so registered secrets cannot survive into the archive; an optional leak guard
fails the export closed if any registered secret is still present.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import platform
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Final, final, override

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from hubfetch.config.settings import Settings
    from hubfetch.security.redaction import JsonValue, Redactor

LOG_EXTENSIONS: Final = frozenset({".jsonl", ".log"})
"""File suffixes the log allowlist may include in a bundle."""
MAX_LOG_MEMBER_BYTES: Final = 1 << 20
"""Upper bound on one sanitized log member inside the archive."""
TRUNCATION_MARKER: Final = "... truncated for support bundle ...\n"
"""Marker appended when a log member exceeded the per-member budget."""
_FIXED_ZIP_DATETIME: Final = (1980, 1, 1, 0, 0, 0)
"""ZIP member timestamp; a fixed epoch keeps byte-identical rebuilds."""

__all__ = [
    "LOG_EXTENSIONS",
    "MAX_LOG_MEMBER_BYTES",
    "TRUNCATION_MARKER",
    "SupportBundleBuilder",
    "SupportBundleError",
    "SupportBundleResult",
    "collect_versions",
    "contains_secret",
]


@dataclass(frozen=True, slots=True)
class SupportBundleError(ValueError):
    """A support-bundle export violated its typed boundary.

    This is the single fail-closed error for denied export paths and for a
    registered secret that would otherwise survive into the archive.
    """

    reason: str

    @override
    def __str__(self) -> str:
        return f"support bundle error: {self.reason}"


@dataclass(frozen=True, slots=True)
class SupportBundleResult:
    """Typed outcome of one ZIP export for UI and evidence consumers."""

    target: Path
    member_count: int
    bytes_written: int
    log_members: tuple[str, ...]
    errors: tuple[str, ...]


def _utc_now() -> datetime:
    """Return the current aware UTC instant for the bundle header."""
    return datetime.now(UTC)


def _package_version(name: str, fallback: str) -> str:
    """Read one installed package version, falling back when uninstalled."""
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return fallback


def collect_versions() -> dict[str, str]:
    """Return the app, runtime, and pinned dependency versions for diagnostics."""
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "architecture": platform.machine(),
        "package": _package_version("hubfetch", "0.1.0"),
        "PySide6": _package_version("PySide6", "unknown"),
        "huggingface_hub": _package_version("huggingface_hub", "unknown"),
        "pydantic": _package_version("pydantic", "unknown"),
        "keyring": _package_version("keyring", "unknown"),
    }


def contains_secret(zip_path: Path, secret: str) -> bool:
    """Return whether ``secret`` appears in any member name or member bytes.

    This is the verification seam the QA flow and tests use to prove that a
    registered sentinel never crossed the serialization boundary.
    """
    if not zip_path.is_file():
        return False
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.namelist():
            if secret in member:
                return True
            if secret in archive.read(member).decode("utf-8", errors="ignore"):
                return True
    return False


def _read_log_text(path: Path) -> str:
    """Read one log file as UTF-8 text; failures are caught by the builder."""
    return path.read_text(encoding="utf-8")


@final
class SupportBundleBuilder:
    """Build a sanitized support ZIP from the typed allowlist."""

    __slots__: Final = ("_clock", "_leak_guard", "_read_log", "_redactor")
    _redactor: Redactor
    _clock: Callable[[], datetime]
    _read_log: Callable[[Path], str]
    _leak_guard: Callable[[], frozenset[str]] | None

    def __init__(
        self,
        redactor: Redactor,
        *,
        clock: Callable[[], datetime] | None = None,
        read_log: Callable[[Path], str] | None = None,
        leak_guard: Callable[[], frozenset[str]] | None = None,
    ) -> None:
        """Bind the redactor and the deterministic/IO seams.

        ``clock`` fixes the bundle header timestamp for reproducible evidence;
        ``read_log`` lets a caller control log reads deterministically; and
        ``leak_guard`` supplies registered secrets whose presence in the final
        archive fails the export closed.
        """
        self._redactor = redactor
        self._clock = clock if clock is not None else _utc_now
        self._read_log = read_log if read_log is not None else _read_log_text
        self._leak_guard = leak_guard

    def build(
        self,
        *,
        target: Path,
        settings: Settings,
        diagnostics: Mapping[str, JsonValue],
        log_dir: Path,
        versions: Mapping[str, str] | None = None,
    ) -> SupportBundleResult:
        """Write the allowlisted archive and fail closed on boundary violations.

        Args:
            target: The ZIP path to create; its parent must already exist.
            settings: Non-secret settings sanitized before serialization.
            diagnostics: The sanitized diagnostic report as JSON-safe values.
            log_dir: Directory scanned for ``.jsonl``/``.log`` log members.
            versions: Version header; defaults to the collected versions.

        Returns:
            The typed result; individual unreadable logs are recorded as errors
            while the remaining allowlisted members still export.

        Raises:
            SupportBundleError: The target is unusable, or a leak-guarded
                secret survived into the archive.
        """
        self._require_target(target)
        version_header = self._version_header(versions)
        diagnostics_payload = dict(diagnostics)
        log_members = self._log_candidates(log_dir)
        errors: list[str] = []
        log_sources: list[tuple[str, str]] = []
        for member_name in log_members:
            source = log_dir / member_name
            try:
                text = self._read_log(source)
            except (OSError, UnicodeError) as error:
                errors.append(f"log {member_name} unreadable: {error}")
                continue
            log_sources.append((member_name, text))
        member_count = 3 + len(log_sources)
        try:
            with zipfile.ZipFile(
                target, mode="w", compression=zipfile.ZIP_DEFLATED
            ) as archive:
                self._write_json(archive, "versions.json", version_header)
                self._write_settings(archive, settings)
                self._write_json(archive, "diagnostics.json", diagnostics_payload)
                for member_name, text in log_sources:
                    self._write_log(archive, member_name, text)
        except OSError as error:
            raise SupportBundleError(
                reason=f"cannot write {target}: {error}"
            ) from error
        self._enforce_leak_guard(target)
        bytes_written = target.stat().st_size
        return SupportBundleResult(
            target=target,
            member_count=member_count,
            bytes_written=bytes_written,
            log_members=tuple(name for name, _text in log_sources),
            errors=tuple(errors),
        )

    def _require_target(self, target: Path) -> None:
        """Fail closed when the target parent cannot host the archive."""
        if not target.parent.is_dir():
            raise SupportBundleError(
                reason=f"export parent is not a directory: {target.parent}"
            )
        if target.is_dir():
            raise SupportBundleError(reason=f"export target is a directory: {target}")

    def _version_header(
        self, versions: Mapping[str, str] | None
    ) -> dict[str, JsonValue]:
        """Merge the collected versions with a deterministic export timestamp."""
        raw = dict(versions) if versions is not None else collect_versions()
        header: dict[str, JsonValue] = dict(raw)
        header["created_at"] = self._clock().isoformat()
        return header

    def _log_candidates(self, log_dir: Path) -> tuple[str, ...]:
        """List allowlisted log filenames, skipping every non-log neighbor."""
        if not log_dir.is_dir():
            return ()
        candidates: list[str] = []
        try:
            with os.scandir(log_dir) as entries:
                for entry in entries:
                    if not entry.is_file():
                        continue
                    if Path(entry.name).suffix in LOG_EXTENSIONS:
                        candidates.append(entry.name)
        except OSError:
            return ()
        return tuple(sorted(candidates))

    def _write_json(
        self, archive: zipfile.ZipFile, member: str, payload: JsonValue
    ) -> None:
        """Serialize one JSON member through the redactor."""
        redacted = self._redactor.redact_value(payload)
        encoded = json.dumps(redacted, sort_keys=True, indent=2).encode("utf-8")
        self._write_member(archive, member, encoded)

    def _write_settings(self, archive: zipfile.ZipFile, settings: Settings) -> None:
        """Serialize settings in JSON mode (bytes become base64) and redact."""
        raw = settings.model_dump(mode="json")
        redacted = self._redactor.redact_value(raw)
        encoded = json.dumps(redacted, sort_keys=True, indent=2).encode("utf-8")
        self._write_member(archive, "settings.json", encoded)

    def _write_log(self, archive: zipfile.ZipFile, member: str, text: str) -> None:
        """Redact, bound, and write one log member."""
        redacted = self._redactor.redact_text(text)
        encoded = redacted.encode("utf-8")
        if len(encoded) > MAX_LOG_MEMBER_BYTES:
            encoded = encoded[:MAX_LOG_MEMBER_BYTES] + TRUNCATION_MARKER.encode("utf-8")
        self._write_member(archive, f"logs/{member}", encoded)

    def _write_member(self, archive: zipfile.ZipFile, member: str, data: bytes) -> None:
        """Write one member with a fixed ZIP timestamp for reproducibility."""
        info = zipfile.ZipInfo(member, date_time=_FIXED_ZIP_DATETIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, data)

    def _enforce_leak_guard(self, target: Path) -> None:
        """Fail closed if any leak-guarded secret reached the archive."""
        guard = self._leak_guard
        if guard is None:
            return
        for secret in guard():
            if contains_secret(target, secret):
                target.unlink(missing_ok=True)
                raise SupportBundleError(
                    reason="a registered secret survived into the support bundle"
                )
