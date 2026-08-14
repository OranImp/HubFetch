"""HTTP routing for the Hub-compatible wire fixture.

The handler mirrors the exact endpoints the pinned ``huggingface_hub``
1.27.0 library calls during dry-run planning: repo-info, tree, and
file-resolve. JSON shapes and failure specs come from
:mod:`tests.hub.fixture_payloads`; this module owns the request routing and
the wire responses.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, override
from urllib.parse import unquote, urlsplit

from .fixture_payloads import (
    DEFAULT_COMMIT,
    DEFAULT_ETAG,
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


class FixtureConfig:
    """Immutable per-server fixture behavior read by every request."""

    repo_type: RepoType = "model"
    repo_id: str = "org/repo"
    commit: str = DEFAULT_COMMIT
    files: tuple[tuple[str, int], ...] = ()
    revisions: tuple[str, ...] = (DEFAULT_REVISION_NAME,)
    error: FixtureError = "none"
    expect_token: str | None = None
    forbid_token: bool = False
    gated: bool = False
    private: bool = False


class FixtureServer(ThreadingHTTPServer):
    config: FixtureConfig = FixtureConfig()


class HubFixtureHandler(BaseHTTPRequestHandler):
    """Serve deterministic Hub API and resolve responses."""

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
            status, error_code, error_message = failure
            self._send_error(
                status,
                head_only=head_only,
                error_code=error_code,
                error_message=error_message,
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
        headers = {
            "X-Repo-Commit": fixture.commit,
            "X-Linked-Size": str(size),
            "ETag": DEFAULT_ETAG,
            "Content-Length": str(size),
        }
        self._send(200, b"", headers, head_only=head_only)

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
