"""Ephemeral local HTTP fixtures for ranges, errors, and auth challenges."""

from __future__ import annotations

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread
from typing import TYPE_CHECKING, Final, override
from urllib.parse import unquote, urlsplit

if TYPE_CHECKING:
    from collections.abc import Generator, Mapping

DEFAULT_CONTENT: Final = b"hubfetch-test-content"


class HttpServerLifecycleError(RuntimeError):
    """Indicate that a local HTTP fixture could not start or stop cleanly."""

    def __init__(self, operation: str, namespace: str) -> None:
        super().__init__(f"HTTP fixture {operation} failed for {namespace}")


class _FixtureServer(ThreadingHTTPServer):
    """Carry immutable fixture configuration to each request handler."""

    namespace: str = ""
    content: bytes = b""


class _FixtureHandler(BaseHTTPRequestHandler):
    """Serve deterministic resources below one namespaced URL prefix."""

    @property
    def _fixture_server(self) -> _FixtureServer:
        server = self.server
        if not isinstance(server, _FixtureServer):
            operation = "handler"
            namespace = "unknown"
            raise HttpServerLifecycleError(operation, namespace)
        return server

    def do_GET(self) -> None:
        """Serve file, status, auth, and health resources."""
        path = unquote(urlsplit(self.path).path)
        prefix = f"/{self._fixture_server.namespace}/"
        if not path.startswith(prefix):
            self._send(404, b"not found")
            return
        self._dispatch(path[len(prefix) :])

    @override
    def log_message(self, format: str, *args: str) -> None:
        """Keep fixture access deterministic and quiet."""

    def _dispatch(self, resource: str) -> None:
        if resource == "file":
            self._send_file()
            return
        if resource == "auth":
            self._send_auth()
            return
        if resource == "health":
            self._send(200, b"ok")
            return
        if resource.startswith("status/"):
            self._send_status(resource.removeprefix("status/"))
            return
        self._send(404, b"not found")

    def _send_file(self) -> None:
        payload = self._fixture_server.content
        range_header = self.headers.get("Range")
        if range_header is None:
            self._send(200, payload, {"Accept-Ranges": "bytes"})
            return
        range_result = _parse_range(range_header, len(payload))
        if range_result is None:
            self._send(416, b"range not satisfiable")
            return
        start, end = range_result
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{len(payload)}",
        }
        self._send(206, payload[start : end + 1], headers)

    def _send_auth(self) -> None:
        if self.headers.get("Authorization") == "Basic dGVzdDp0ZXN0":
            self._send(200, b"authenticated")
            return
        self._send(
            401,
            b"authentication required",
            {"WWW-Authenticate": 'Basic realm="hubfetch-test"'},
        )

    def _send_status(self, raw_status: str) -> None:
        try:
            status = int(raw_status)
        except ValueError:
            self._send(400, b"invalid status")
            return
        if not 100 <= status <= 599:
            self._send(400, b"invalid status")
            return
        self._send(status, f"status {status}".encode())

    def _send(
        self,
        status: int,
        payload: bytes,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        _ = self.send_response(status)
        self.send_header("Content-Length", str(len(payload)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        _ = self.end_headers()
        _ = self.wfile.write(payload)


def _parse_range(value: str, payload_size: int) -> tuple[int, int] | None:
    if not value.startswith("bytes=") or "," in value:
        return None
    start_text, separator, end_text = value.removeprefix("bytes=").partition("-")
    if not separator:
        return None
    range_result: tuple[int, int] | None = None
    try:
        if not start_text:
            suffix_length = int(end_text)
            if suffix_length > 0:
                range_result = (max(payload_size - suffix_length, 0), payload_size - 1)
        else:
            start = int(start_text)
            end = payload_size - 1 if not end_text else int(end_text)
            range_result = (start, min(end, payload_size - 1))
    except ValueError:
        return None
    if range_result is None:
        return None
    start, end = range_result
    if start < 0 or start >= payload_size or end < start:
        return None
    return range_result


class LocalHttpServer:
    """Own one ephemeral, namespaced local HTTP server thread."""

    __slots__: Final = ("_closed", "_namespace", "_server", "_thread")
    _closed: bool
    _namespace: str
    _server: _FixtureServer
    _thread: Thread

    def __init__(self, namespace: str, content: bytes = DEFAULT_CONTENT) -> None:
        self._namespace = namespace
        self._closed = False
        self._server = _FixtureServer(("127.0.0.1", 0), _FixtureHandler)
        self._server.namespace = namespace
        self._server.content = content
        started = Event()
        self._thread = Thread(target=self._serve, args=(started,), daemon=True)
        self._thread.start()
        if not started.wait(2.0):
            self.close()
            operation = "start"
            raise HttpServerLifecycleError(operation, namespace)

    @property
    def port(self) -> int:
        """Return the operating-system-assigned ephemeral port."""
        return self._server.server_port

    @property
    def closed(self) -> bool:
        """Return whether the server thread has stopped and cleanup ran."""
        return self._closed and not self._thread.is_alive()

    def url_for(self, resource: str) -> str:
        """Build a URL for a resource within this server namespace."""
        return f"http://127.0.0.1:{self.port}/{self._namespace}/{resource.lstrip('/')}"

    def close(self) -> None:
        """Stop the server and join its worker thread within a bound."""
        if self._closed:
            return
        self._closed = True
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(2.0)
        if self._thread.is_alive():
            operation = "stop"
            raise HttpServerLifecycleError(operation, self._namespace)

    def _serve(self, started: Event) -> None:
        started.set()
        self._server.serve_forever(poll_interval=0.05)


@contextmanager
def local_http_server(
    *, namespace: str, content: bytes = DEFAULT_CONTENT
) -> Generator[LocalHttpServer, None, None]:
    """Create a local HTTP fixture with guaranteed shutdown."""
    server = LocalHttpServer(namespace=namespace, content=content)
    try:
        yield server
    finally:
        server.close()
