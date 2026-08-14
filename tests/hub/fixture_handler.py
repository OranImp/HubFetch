# noqa: SIZE_OK - one fixture module must serve the full Hub surface (repo-info,
# tree, resolve with download ranges/errors/auth) shared by planning and download
# tests.
# pyright: reportPrivateUsage = false
"""HTTP routing for the Hub-compatible wire fixture.

The handler mirrors the exact endpoints the pinned ``huggingface_hub`` 1.27.0
library calls: repo-info, tree, and file-resolve, plus download GETs with
range/error/auth behavior. JSON shapes and failure specs come from
:mod:`tests.hub.fixture_payloads`. The ``reportPrivateUsage`` directive allows
importing the shared range parser from ``tests.helpers.http_server``.
"""

from __future__ import annotations

import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, override
from urllib.parse import unquote, urlsplit

from tests.helpers.http_server import _parse_range

from .fixture_payloads import (
    DEFAULT_COMMIT,
    DEFAULT_REVISION_NAME,
    PLURAL,
    RESOLVE_PREFIX,
    FixtureError,
    RepoType,
    failure_spec,
    repo_info_payload,
)

if TYPE_CHECKING:
    from collections.abc import Mapping


def _file_etag(filename: str) -> str:
    """Return a deterministic per-file ETag giving each file a unique blob.

    The library names the cache blob after the ETag, so a constant ETag would
    make every file collide on one blob slot and later files appear already
    cached; hashing the filename keeps it filesystem-safe for nested paths.
    """
    digest = hashlib.sha256(filename.encode("utf-8")).hexdigest()[:32]
    return f'"fixture-{digest}"'


class FixtureConfig:
    """Per-server fixture behavior, initialized fresh on every instance.

    ``content`` maps a filename to the bytes served for a download GET (sizes
    in ``files`` must match); ``download_error`` maps a filename to a behavior
    tag (``"truncate_once"`` forces byte-range resume, ``"checksum"`` fails the
    library's consistency check); ``request_log`` records every resolve request
    for assertions. Every field is an instance attribute so concurrent fixtures
    never share mutable state.
    """

    def __init__(self) -> None:
        self.repo_type: RepoType = "model"
        self.repo_id: str = "org/repo"
        self.commit: str = DEFAULT_COMMIT
        self.files: tuple[tuple[str, int], ...] = ()
        self.revisions: tuple[str, ...] = (DEFAULT_REVISION_NAME,)
        self.error: FixtureError = "none"
        self.expect_token: str | None = None
        self.forbid_token: bool = False
        self.gated: bool = False
        self.private: bool = False
        self.content: dict[str, bytes] = {}
        self.download_error: dict[str, str] = {}
        self.truncated_files: set[str] = set()
        self.request_log: list[dict[str, str | None]] = []


class FixtureServer(ThreadingHTTPServer):
    config: FixtureConfig = FixtureConfig()


class HubFixtureHandler(BaseHTTPRequestHandler):
    """Serve deterministic Hub API and resolve responses."""

    close_connection: bool = True
    """Default connection behavior; the truncation path toggles it mid-response."""

    @property
    def _fixture(self) -> FixtureConfig:
        server = self.server
        assert isinstance(server, FixtureServer)
        return server.config

    @override
    def log_message(self, format: str, *args: object) -> None:
        """Keep fixture access deterministic and quiet."""

    def do_GET(self) -> None:
        self._route()

    def do_HEAD(self) -> None:
        self._route(head_only=True)

    def _route(self, *, head_only: bool = False) -> None:
        fixture = self._fixture
        path = unquote(urlsplit(self.path).path)
        plural = PLURAL[fixture.repo_type]
        resolve_prefix = RESOLVE_PREFIX[fixture.repo_type]
        if path.startswith(f"/api/{plural}/{fixture.repo_id}/tree/"):
            self._send_tree(path, head_only=head_only)
            return
        if path.startswith(f"/api/{plural}/{fixture.repo_id}"):
            self._send_repo_info(path, head_only=head_only)
            return
        if path.startswith(f"/{resolve_prefix}{fixture.repo_id}/resolve/"):
            self._send_resolve(path, head_only=head_only)
            return
        self._send_json(404, {"error": "not found"}, head_only=head_only)

    def _authorization(self) -> str | None:
        value = self.headers.get("Authorization")
        return value or None

    def _auth_ok(self) -> bool:
        expected = self._fixture.expect_token
        if self._fixture.forbid_token:
            return self._authorization() is None
        if expected is None:
            return True
        return self._authorization() == f"Bearer {expected}"

    def _send_repo_info(self, path: str, *, head_only: bool) -> None:
        fixture = self._fixture
        if not self._auth_ok():
            self._send_error(
                401,
                head_only=head_only,
                error_code=None,
                error_message="Invalid credentials in Authorization header",
            )
            return
        revision = self._revision_from_path(path)
        if revision is not None and self._revision_unknown(revision):
            self._send_error(404, head_only=head_only, error_code="RevisionNotFound")
            return
        failure = failure_spec(fixture.error)
        if failure is not None:
            self._send_error(
                failure[0],
                head_only=head_only,
                error_code=failure[1],
                error_message=failure[2],
            )
            return
        payload = repo_info_payload(
            fixture.repo_type,
            fixture.repo_id,
            fixture.commit,
            fixture.files,
            gated=fixture.gated,
            private=fixture.private,
        )
        self._send_json(200, payload, head_only=head_only)

    def _send_tree(self, path: str, *, head_only: bool) -> None:
        fixture = self._fixture
        revision = path.rsplit("/tree/", 1)[-1]
        if self._revision_unknown(revision):
            self._send_json(404, {"error": "revision not found"}, head_only=head_only)
            return
        entries = [
            {
                "type": "file",
                "path": name,
                "size": size,
                "oid": f"{index:040x}",
                "lfs": None,
            }
            for index, (name, size) in enumerate(fixture.files, start=1)
        ]
        self._send_json(200, entries, head_only=head_only)

    def _send_resolve(self, path: str, *, head_only: bool) -> None:
        fixture = self._fixture
        resolve_prefix = RESOLVE_PREFIX[fixture.repo_type]
        remainder = path.removeprefix(f"/{resolve_prefix}{fixture.repo_id}/resolve/")
        parts = remainder.split("/", 1)
        if len(parts) != 2:
            self._send_json(404, {"error": "not found"}, head_only=head_only)
            return
        revision, filename = parts
        if self._revision_unknown(revision):
            self._send_error(404, head_only=head_only, error_code="RevisionNotFound")
            return
        size = dict(fixture.files).get(filename)
        if size is None:
            self._send_error(404, head_only=head_only, error_code="EntryNotFound")
            return
        fixture.request_log.append(
            {
                "method": "HEAD" if head_only else "GET",
                "filename": filename,
                "range": self.headers.get("Range"),
            }
        )
        if head_only:
            self._send_resolve_head(filename, size)
            return
        self._send_resolve_body(filename, size)

    def _send_resolve_head(self, filename: str, size: int) -> None:
        """Serve the resolve metadata the library's HEAD call consumes."""
        headers = {
            "X-Repo-Commit": self._fixture.commit,
            "X-Linked-Size": str(size),
            "ETag": _file_etag(filename),
            "Content-Length": str(size),
        }
        self._send(200, b"", headers, head_only=True)

    def _send_resolve_body(self, filename: str, declared_size: int) -> None:
        """Serve the file bytes for a download GET, honoring range and errors."""
        fixture = self._fixture
        behavior = fixture.download_error.get(filename)
        body = fixture.content.get(filename, b"")
        if behavior == "checksum":
            # Serve fewer bytes than the HEAD declared so the library's
            # size-consistency check fails after the body is consumed.
            body = body[: max(0, len(body) - 3)]
        range_header = self.headers.get("Range")
        range_result = _parse_range(range_header, len(body)) if range_header else None
        if behavior == "truncate_once" and filename not in fixture.truncated_files:
            fixture.truncated_files.add(filename)
            self._send_truncated_body(body, declared_size, filename)
            return
        headers = {
            "X-Repo-Commit": fixture.commit,
            "ETag": _file_etag(filename),
        }
        if range_result is None:
            headers["Accept-Ranges"] = "bytes"
            headers["Content-Length"] = str(len(body))
            self._send(200, body, headers)
            return
        start, end = range_result
        headers["Accept-Ranges"] = "bytes"
        headers["Content-Range"] = f"bytes {start}-{end}/{len(body)}"
        self._send(206, body[start : end + 1], headers)

    def _send_truncated_body(
        self, body: bytes, declared_size: int, filename: str
    ) -> None:
        """Write one full 10 MiB chunk, then close the connection mid-body.

        The client yields the chunk (advancing its resume position) and then
        observes a peer close, so the pinned library's ``http_get`` retry resumes
        with a ``Range`` header; truncating before a full chunk would make the
        transport raise before yielding any bytes and no resume could be seen.
        """
        chunk_size = 10 * 1024 * 1024
        _ = self.send_response(200)
        self.send_header("Content-Length", str(declared_size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", _file_etag(filename))
        self.send_header("X-Repo-Commit", self._fixture.commit)
        _ = self.end_headers()
        _ = self.wfile.write(body[:chunk_size])
        self.close_connection = True

    def _revision_from_path(self, path: str) -> str | None:
        fixture = self._fixture
        plural = PLURAL[fixture.repo_type]
        prefix = f"/api/{plural}/{fixture.repo_id}"
        remainder = path.removeprefix(prefix)
        if not remainder:
            return None
        if remainder.startswith("/revision/"):
            return remainder.removeprefix("/revision/")
        return None

    def _revision_unknown(self, revision: str) -> bool:
        fixture = self._fixture
        return revision not in fixture.revisions and revision != fixture.commit

    def _send_error(
        self,
        status: int,
        *,
        head_only: bool = False,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        headers: dict[str, str] = {}
        if error_code is not None:
            headers["X-Error-Code"] = error_code
        if error_message is not None:
            headers["X-Error-Message"] = error_message
        self._send(status, b"{}", headers, head_only=head_only)

    def _send_json(self, status: int, payload: object, *, head_only: bool) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self._send(
            status, body, {"Content-Type": "application/json"}, head_only=head_only
        )

    def _send_headers(
        self, status: int, body: bytes, headers: Mapping[str, str]
    ) -> None:
        _ = self.send_response(status)
        if "Content-Length" not in headers:
            self.send_header("Content-Length", str(len(body)))
        for name, value in headers.items():
            self.send_header(name, value)
        _ = self.end_headers()

    def _send(
        self,
        status: int,
        body: bytes,
        headers: Mapping[str, str] | None = None,
        *,
        head_only: bool = False,
    ) -> None:
        self._send_headers(status, body, headers or {})
        if not head_only:
            _ = self.wfile.write(body)
